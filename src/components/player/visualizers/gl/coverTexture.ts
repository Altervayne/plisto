/*
 * The cover's pixels as a texture, shared by every candidate that draws the art. The bitmap arrives
 * flipped for GL, so it uploads as is; mipmaps carry the blurred looks, and the mirrored wrap keeps a
 * lookup past the art's edge seamless.
 */

export interface CoverTexture {
  tex: WebGLTexture;
  // Uploads the bitmap when it is not the one on the texture; true when it did.
  sync: (bitmap: ImageBitmap) => boolean;
  dispose: () => void;
}

export function createCoverTexture(gl: WebGL2RenderingContext): CoverTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("texture allocation failed");
  let uploaded: ImageBitmap | null = null;

  const sync = (bitmap: ImageBitmap) => {
    if (bitmap === uploaded) return false;
    uploaded = bitmap;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    return true;
  };

  return { tex, sync, dispose: () => gl.deleteTexture(tex) };
}
