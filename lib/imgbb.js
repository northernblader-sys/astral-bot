/**
 * lib/imgbb.js — uploads an image buffer to ImgBB and returns its public
 * URL. Used by lib/pfp.js and lib/banner.js so .setpfp/.setbanner no
 * longer write to local disk (media/pfp, media/banner) — this was one of
 * the things filling up the VPS's disk and causing ENOSPC crashes, since
 * nothing ever cleaned old uploads out of those folders.
 *
 * Requires config.imgbbApiKey (IMGBB_API_KEY in .env). Get a free key at
 * https://api.imgbb.com/.
 */
import { config } from '../config.js'

const IMGBB_ENDPOINT = 'https://api.imgbb.com/1/upload'

/**
 * Uploads `buffer` (raw image bytes) to ImgBB and returns the hosted URL.
 * Throws if IMGBB_API_KEY isn't configured or the upload fails — callers
 * (lib/pfp.js, lib/banner.js) surface this as a normal command error, same
 * as any other "couldn't read that image" failure.
 */
export async function uploadToImgbb(buffer, fileName) {
  if (!config.imgbbApiKey) {
    throw new Error(
      'IMGBB_API_KEY is not set — add it to your VPS .env (get a free key at https://api.imgbb.com/).',
    )
  }

  const form = new FormData()
  // ImgBB wants the image as base64 in a form field (raw multipart bytes
  // also works, but base64 avoids any ambiguity with the Blob content-type).
  form.append('image', buffer.toString('base64'))
  form.append('name', fileName)

  const res = await fetch(`${IMGBB_ENDPOINT}?key=${config.imgbbApiKey}`, {
    method: 'POST',
    body:   form,
  })

  const json = await res.json().catch(() => null)

  if (!res.ok || !json?.success) {
    const reason = json?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`ImgBB upload failed: ${reason}`)
  }

  // display_url is the direct, permanently-hosted image link ImgBB gives
  // back — this is what gets stored on player.pfp / player.banner and
  // later fetched by lib/profile-card-render.mjs.
  return json.data.display_url
}
