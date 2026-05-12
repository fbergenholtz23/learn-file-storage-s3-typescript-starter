import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import {type BunRequest, S3Client} from "bun";
import {BadRequestError, NotFoundError, UserForbiddenError} from "./errors.ts";
import {getUser} from "../db/users.ts";
import {getBearerToken, validateJWT} from "../auth.ts";
import {getVideo, updateVideo} from "../db/videos.ts";
import {mediaTypeToExt} from "./assets.ts";
import {randomBytes} from "crypto";
import path from "node:path";
import { rm } from "fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const videoMetaData = getVideo(cfg.db, videoId);
  if (!videoMetaData) {
    throw new NotFoundError("video not found");
  }

  if (videoMetaData?.userID != userID) {
    throw new UserForbiddenError("Not valid credentials");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");

  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const type = videoFile.type;
  if (type != "video/mp4") {
    throw new BadRequestError("Invalid file type");
  }

  const videoData = await videoFile.arrayBuffer();
  const ext = mediaTypeToExt(type);
  let videoKey = `${randomBytes(32).toString("hex")}${ext}`;
  const filePath = `/tmp/${videoId}.mp4`;
  await Bun.write(filePath, videoData);
  const aspectRatio = await getVideoAspectRatio(filePath);
  videoKey = `${aspectRatio}/${videoKey}`;
  const processedVideoPath = await processVideoForFastStart(filePath);

  const s3File = cfg.s3Client.file(videoKey, { bucket: cfg.s3Bucket});
  const localFile = Bun.file(processedVideoPath);
  await s3File.write(localFile, { type: "video/mp4"});

  videoMetaData.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoKey}`;
  updateVideo(cfg.db, videoMetaData);

  await rm(filePath, { force: true });
  await rm(processedVideoPath, { force: true });

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filepath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filepath], {
    stderr: "pipe",
  });

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  if (await proc.exited != 0) {
    throw new Error("Error with getting video aspect");
  }

  const width = JSON.parse(stdoutText)["streams"][0]["width"];
  const height = JSON.parse(stdoutText)["streams"][0]["height"];

  const ratio = width/height;

  if (Math.abs(ratio - 16/9) < 0.1) {
    return "landscape";
  } else if (Math.abs(ratio - 9/16) < 0.1) {
    return "portrait";
  } else {
    return "other";
  }
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn([
      "ffmpeg",
    "-i", inputFilePath,
    "-movflags", "faststart",
    "-map_metadata", "0",
    "-codec", "copy",
    "-f", "mp4",
    outputFilePath]);

  return outputFilePath;
}
