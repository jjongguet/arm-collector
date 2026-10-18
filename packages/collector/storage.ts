import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  constants,
  realpathSync,
} from "node:fs";
import { resolve, dirname, join, parse } from "node:path";
import { randomBytes } from "node:crypto";
export function noSymlinks(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split("/")
    .filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Symlink refused");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export function privateDir(path: string) {
  noSymlinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Private owned 0700 directory required");
  return realpathSync(path);
}
export function readPrivate(path: string): string {
  noSymlinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Private owned 0600 file required");
    if (stat.size > 2 * 1024 * 1024) throw new Error("Storage cap");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export function atomicPrivate(path: string, value: string) {
  noSymlinks(path);
  privateDir(dirname(path));
  if (Buffer.byteLength(value) > 2 * 1024 * 1024)
    throw new Error("Storage cap");
  const temp = join(dirname(path), `.arm-${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, value);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export function removePrivate(path: string) {
  noSymlinks(path);
  try {
    readPrivate(path);
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
