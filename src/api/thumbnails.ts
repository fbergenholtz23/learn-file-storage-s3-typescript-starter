import {getBearerToken, validateJWT} from "../auth";
import {respondWithJSON} from "./json";
import {getVideo, updateVideo} from "../db/videos";
import type {ApiConfig} from "../config";
import type {BunRequest} from "bun";
import {BadRequestError, NotFoundError, UserForbiddenError} from "./errors";
import * as path from "node:path";
import {mediaTypeToExt} from "./assets.ts";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const formData = await req.formData();
  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }
  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }
  const type = file.type;
  const imageData = await file.arrayBuffer();
  const ext = mediaTypeToExt(type);
  const filePath = path.join(cfg.assetsRoot, `${videoId}${ext}`);
  console.log(filePath);
  await Bun.write(filePath, imageData);

  const videoMetaData = getVideo(cfg.db, videoId);
  if (!videoMetaData) {
    throw new NotFoundError("video not found");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);


  if (videoMetaData?.userID != userID) {
    throw new UserForbiddenError("Not valid credentials");
  }
  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  videoMetaData.thumbnailURL = `http://localhost:${cfg.port}/${filePath}`;

  updateVideo(cfg.db, videoMetaData);


  return respondWithJSON(200, videoMetaData);
}
