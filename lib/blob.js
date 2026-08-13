const { put, del } = require("@vercel/blob");

/* Server-proxied upload: the browser POSTs the raw file bytes to our own
   endpoint (same-origin, no external SDK needed in the page); this
   function pipes the Node request stream straight into Vercel Blob's put()
   without buffering the whole file in memory. Simpler and more robust than
   the client-direct-upload token dance, at the cost of files passing
   through the Function — fine given these are small PDFs/images, well
   under Vercel's request body limit. */
async function uploadFile(pathname, req, contentType) {
  const blob = await put(pathname, req, {
    access: "public",
    contentType,
    addRandomSuffix: true,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

/* Best-effort cleanup on replace/delete — never blocks the caller's own
   success path if Blob is briefly unreachable. */
async function deleteFile(url) {
  if (!url) return;
  try {
    await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (err) {
    console.error("blob delete failed", err);
  }
}

module.exports = { uploadFile, deleteFile };
