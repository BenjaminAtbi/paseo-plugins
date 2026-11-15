import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A file under $PASEO_HOME/load-balancer. */
export function dataPath(name: string): string {
  return join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "load-balancer", name);
}

/** The parsed file, or undefined if it is missing or unreadable. */
export async function readData(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function writeData(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}
