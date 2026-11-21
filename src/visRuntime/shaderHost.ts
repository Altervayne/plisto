/*
 * The served shader page's half of the runtime. A kind that declares only a fragment source loads the
 * shader page with `?shader=<path>`; the runtime fetches that source from the plugin's own origin when
 * the init arrives and mounts it with the shader form.
 */

// -- Local Imports --
import { shaderForm } from "./forms/shader";

// -- Type Imports --
import type { Registration } from "./lifecycle";

/** Where the host serves the shader page. */
export const SHADER_PAGE_PATH = "/_plisto/vis/1/shader.html";

/** Whether the frame is the served shader page. */
export function isShaderPage(pathname: string): boolean {
  return pathname === SHADER_PAGE_PATH;
}

/** Fetches the source named by the page's `shader` parameter and builds its registration. */
export async function loadShader(
  href: string,
  fetcher: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>,
): Promise<Registration> {
  const page = new URL(href);
  const path = page.searchParams.get("shader");
  if (!path) throw new Error("the shader page was opened without a shader path");
  const url = new URL(path, `${page.origin}/`);
  if (url.origin !== page.origin) throw new Error("the shader path must stay on the plugin's origin");
  const res = await fetcher(url.href);
  if (!res.ok) throw new Error(`the shader ${path} could not be read (${res.status})`);
  return shaderForm({ source: await res.text() });
}
