import { getSupabaseConfig } from "@/lib/supabase/config";
import { MATERIALS_BUCKET } from "./config";

export class UploadError extends Error {
  constructor(
    message: string,
    readonly aborted = false,
  ) {
    super(message);
  }
}

type UploadOptions = {
  path: string;
  file: Blob;
  contentType: string;
  // The signed-in user's access token. Storage policies decide what it may write.
  accessToken: string;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
};

function messageForStatus(status: number, body: string) {
  if (status === 413 || /too large|exceeded the maximum/i.test(body)) return "This file is larger than the upload limit.";
  if (status === 415 || /mime type/i.test(body)) return "This file type isn't supported.";
  if (status === 401 || /jwt|unauthorized/i.test(body)) return "Your session has expired. Please sign in again.";
  if (status === 403 || /row-level security|not authorized/i.test(body)) {
    return "You can't upload to this subject. It may have been deleted.";
  }
  return "The upload failed. Please try again.";
}

// Sends the file straight from the browser to Supabase Storage. XMLHttpRequest
// is used instead of the Supabase client because it reports upload progress.
export function uploadToStorage({ path, file, contentType, accessToken, onProgress, signal }: UploadOptions) {
  const { url, key } = getSupabaseConfig();
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");

  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${url}/storage/v1/object/${MATERIALS_BUCKET}/${encodedPath}`);
    request.setRequestHeader("authorization", `Bearer ${accessToken}`);
    request.setRequestHeader("apikey", key);
    request.setRequestHeader("content-type", contentType);
    request.setRequestHeader("cache-control", "max-age=3600");
    // Never overwrite: every upload has its own material id folder.
    request.setRequestHeader("x-upsert", "false");

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new UploadError(messageForStatus(request.status, request.responseText)));
    };
    request.onerror = () => reject(new UploadError("We couldn't reach the server. Check your connection and try again."));
    request.onabort = () => reject(new UploadError("Upload cancelled.", true));

    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}
