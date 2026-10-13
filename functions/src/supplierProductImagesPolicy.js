const sharp = require("sharp");
const { HttpsError } = require("firebase-functions/v2/https");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16000000;
const MAX_DERIVATIVE_BYTES = 1024 * 1024;
const IMAGE_POLICY_VERSION = 1;
const mimeFormats = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
const sizes = { thumbnail: 160, display: 800 };

function imageInput(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new HttpsError("invalid-argument", "Upload a nonempty image of at most 5 MiB.");
  }
  if (typeof mimeType !== "string" || !Object.hasOwn(mimeFormats, mimeType)) throw new HttpsError("invalid-argument", "Use a JPEG, PNG or WebP image.");
}

async function createImageVariants(bytes, mimeType) {
  imageInput(bytes, mimeType);
  try {
    const input = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
    const metadata = await input.metadata();
    if (metadata.format !== mimeFormats[mimeType] || !metadata.width || !metadata.height
      || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages || 1) !== 1) {
      throw new Error("Unsupported image dimensions, format or animation.");
    }
    const variants = {};
    for (const [name, size] of Object.entries(sizes)) {
      // A real decode is mandatory; rotation applies EXIF, and no metadata is copied.
      const output = await input.clone().rotate().resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: name === "thumbnail" ? 75 : 82, effort: 4 }).toBuffer({ resolveWithObject: true });
      if (!output.data.length || output.data.length > MAX_DERIVATIVE_BYTES) throw new Error("Image derivative is too large.");
      variants[name] = { bytes: output.data, width: output.info.width, height: output.info.height };
    }
    return variants;
  } catch {
    throw new HttpsError("invalid-argument", "This image cannot be decoded safely. Use a static JPEG, PNG or WebP image of at most 16 megapixels.");
  }
}

module.exports = { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_DERIVATIVE_BYTES, IMAGE_POLICY_VERSION, mimeFormats, sizes, imageInput, createImageVariants };
