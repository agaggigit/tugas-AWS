import {
  S3Client, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const keyOf = (id) => `items/${id}.json`;

const res = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: data === undefined ? "" : JSON.stringify(data),
});

async function readItem(id) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyOf(id) }));
    return JSON.parse(await out.Body.transformToString());
  } catch (e) {
    if (e.name === "NoSuchKey") return null;
    throw e;
  }
}

async function writeItem(item) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: keyOf(item.itemId),
    Body: JSON.stringify(item),
    ContentType: "application/json",
  }));
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString()
    : event.body;
  return JSON.parse(raw); // error -> ditangkap sebagai 400
}

export const handler = async (event) => {
  const method = event.requestContext.http.method;
  const parts = event.rawPath.split("/").filter(Boolean); // ["items"] atau ["items", "<id>"]
  const id = parts[1];

  if (parts[0] !== "items") return res(404, { message: "Not found" });

  let body;
  try {
    body = parseBody(event);
  } catch {
    return res(400, { message: "Body bukan JSON yang valid" });
  }

  try {
    // POST /items : tambah alat baru
    if (method === "POST" && !id) {
      if (!body.itemName) return res(400, { message: "itemName wajib diisi" });
      const item = {
        itemId: randomUUID(),
        itemName: body.itemName,
        status: "AVAILABLE",
        borrowerName: null,
        borrowerNim: null,
        borrowedAt: null,
        dueDate: null,
      };
      await writeItem(item);
      return res(201, item);
    }

    // GET /items : daftar semua alat (1 list + 1 baca per alat)
    if (method === "GET" && !id) {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "items/" }));
      const ids = (list.Contents ?? []).map((o) => o.Key.slice("items/".length, -".json".length));
      const items = await Promise.all(ids.map(readItem));
      return res(200, items.filter(Boolean));
    }

    // PUT /items/{id} : ubah data, termasuk pinjam / kembalikan
    if (method === "PUT" && id) {
      const current = await readItem(id);
      if (!current) return res(404, { message: "Item tidak ditemukan" });
      if (body.status === "BORROWED" && current.status === "BORROWED") {
        return res(409, { message: "Item sedang dipinjam" });
      }
      const allowed = ["itemName", "status", "borrowerName", "borrowerNim", "borrowedAt", "dueDate"];
      const updated = { ...current };
      for (const f of allowed) if (f in body) updated[f] = body[f];
      await writeItem(updated);
      return res(200, updated);
    }

    // DELETE /items/{id}
    if (method === "DELETE" && id) {
      if (!(await readItem(id))) return res(404, { message: "Item tidak ditemukan" });
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyOf(id) }));
      return res(204);
    }

    return res(405, { message: "Method tidak didukung" });
  } catch (err) {
    console.error(err);
    return res(500, { message: "Internal server error" });
  }
};