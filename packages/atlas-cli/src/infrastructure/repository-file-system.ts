import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";

export interface RepositoryFileSystem {
  realPath(path: string): Promise<string>;
  getStats(path: string): Promise<Stats>;
  getLinkStats(path: string): Promise<Stats>;
  readDirectory(path: string): Promise<Dirent[]>;
  readFile(path: string): Promise<Buffer>;
}

export const nodeRepositoryFileSystem: RepositoryFileSystem = {
  realPath: (path) => realpath(path),
  getStats: (path) => stat(path),
  getLinkStats: (path) => lstat(path),
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  readFile: (path) => readFile(path),
};
