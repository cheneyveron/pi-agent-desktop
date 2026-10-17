import { encodeFilePathForApi } from "./file-paths";

export const PROJECT_UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PROJECT_UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export type ProjectUploadConflictStrategy = "error" | "overwrite" | "skip";

export interface ProjectUploadError {
  name: string;
  error: string;
}

export interface ProjectUploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: ProjectUploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

/** Multipart upload into an allowed project directory (browser / WebView). */
export function uploadProjectFiles(
  targetDirectory: string,
  files: File[],
  strategy: ProjectUploadConflictStrategy,
  onProgress?: (progress: number) => void,
): Promise<{ status: number; data: ProjectUploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: ProjectUploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as ProjectUploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}
