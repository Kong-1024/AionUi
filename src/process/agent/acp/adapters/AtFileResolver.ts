import { promises as fs } from 'fs';
import * as path from 'path';
import { extractAtPaths, parseAllAtCommands, reconstructQuery } from '@/common/chat/atCommandParser';

// ---------------------------------------------------------------------------
// AtFileResolver
// ---------------------------------------------------------------------------

/**
 * Resolves `@file` references in user messages:
 * - Looks up referenced files in the workspace directory
 * - Reads their content and appends it to the prompt
 * - Skips uploaded files (handled natively by the backend CLI)
 *
 * Extracted from AcpAgent.processAtFileReferences / resolveAtPath / findFileInWorkspace.
 */
export class AtFileResolver {
  constructor(private workspace: string) {}

  updateWorkspace(workspace: string): void {
    this.workspace = workspace;
  }

  /**
   * Process @ file references in the content.
   * Returns the reconstructed message with file contents appended.
   */
  async resolve(content: string, uploadedFiles?: string[]): Promise<string> {
    if (!this.workspace) return content;

    const parts = parseAllAtCommands(content);
    const atPaths = extractAtPaths(content);

    if (atPaths.length === 0) return content;

    const resolvedFiles = new Map<string, string>();
    const referencesToRemove = new Set<string>();

    for (const atPath of atPaths) {
      // Skip uploaded files — let the backend CLI handle them natively
      const matchedUpload = uploadedFiles?.find((filePath) => {
        if (atPath === filePath) return true;
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        return atPath === fileName;
      });

      if (matchedUpload) {
        // Filename-only reference when full-path already exists → remove duplicate
        if (atPath !== matchedUpload) {
          referencesToRemove.add(atPath);
        }
        continue;
      }

      // Try to resolve workspace file
      const resolvedPath = await this.resolveAtPath(atPath);
      if (resolvedPath) {
        try {
          const fileContent = await fs.readFile(resolvedPath, 'utf-8');
          resolvedFiles.set(atPath, fileContent);
        } catch {
          // Binary file — keep @ reference for CLI to handle
          console.warn(`[ACP] Skipping binary file ${atPath} (will be handled by CLI)`);
        }
      }
    }

    if (resolvedFiles.size === 0 && referencesToRemove.size === 0) {
      return content;
    }

    // Reconstruct message
    const reconstructed = reconstructQuery(parts, (atPath) => {
      if (referencesToRemove.has(atPath)) return '';
      if (resolvedFiles.has(atPath)) return atPath;
      return '@' + atPath;
    });

    // Append file contents
    let result = reconstructed;
    if (resolvedFiles.size > 0) {
      result += '\n\n--- Referenced file contents ---';
      for (const [atPath, fileContent] of resolvedFiles) {
        result += `\n\n[Content of ${atPath}]:\n${fileContent}`;
      }
      result += '\n--- End of file contents ---';
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async resolveAtPath(atPath: string): Promise<string | null> {
    // Direct path
    const directPath = path.resolve(this.workspace, atPath);
    try {
      const stats = await fs.stat(directPath);
      if (stats.isFile()) return directPath;
      return null;
    } catch {
      // Not found directly — try search
    }

    // Search by filename in workspace
    try {
      return await this.findFile(this.workspace, path.basename(atPath));
    } catch {
      return null;
    }
  }

  private async findFile(dir: string, fileName: string, maxDepth = 3, depth = 0): Promise<string | null> {
    if (depth > maxDepth) return null;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) {
          return fullPath;
        }
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const found = await this.findFile(fullPath, fileName, maxDepth, depth + 1);
          if (found) return found;
        }
      }
    } catch {
      // Permission errors
    }
    return null;
  }
}
