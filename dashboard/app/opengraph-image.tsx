import { ogAlt, ogContentType, ogSize, raceImage } from "../lib/ogImage";

export const runtime = "nodejs";
export const revalidate = 300;
export const alt = ogAlt;
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return raceImage();
}
