const { handleUpload } = require("@vercel/blob/client");

/* Client-upload flow: the browser asks this endpoint for a short-lived
   upload token, then PUTs the file bytes straight to Vercel Blob — the
   file body never passes through this Serverless Function, so upload size
   is not limited by function payload limits. Reused by every section that
   needs file uploads (payroll attachments, permits, future document
   types); the caller identifies what's being uploaded via `clientPayload`. */
async function handleBlobUpload(req, res, { body, onBeforeGenerateToken, onUploadCompleted }) {
  const jsonResponse = await handleUpload({
    request: req,
    body,
    onBeforeGenerateToken,
    onUploadCompleted,
  });
  res.status(200).json(jsonResponse);
}

module.exports = { handleBlobUpload };
