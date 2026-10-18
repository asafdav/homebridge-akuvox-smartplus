export function snapshotArgs(rtspUrl: string, width: number, height: number): string[] {
  return [
    '-rtsp_transport', 'udp',
    '-i', rtspUrl,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    '-f', 'image2',
    '-c:v', 'mjpeg',
    '-',
  ];
}

export interface VideoStreamParams {
  rtspUrl: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  payloadType: number;
  ssrc: number;
  srtpParams: string;
  targetAddress: string;
  targetPort: number;
  mtu: number;
}

/** ffmpeg arguments that transcode the door RTSP to an SRTP H.264 stream HomeKit can play. */
export function videoStreamArgs(p: VideoStreamParams): string[] {
  return [
    '-rtsp_transport', 'udp',
    '-i', p.rtspUrl,
    '-an', '-sn', '-dn',
    '-codec:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'mpeg',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-r', String(p.fps),
    '-vf', `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2`,
    '-b:v', `${p.bitrateKbps}k`,
    '-maxrate', `${p.bitrateKbps}k`,
    '-bufsize', `${p.bitrateKbps * 2}k`,
    '-payload_type', String(p.payloadType),
    '-ssrc', String(p.ssrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', p.srtpParams,
    `srtp://${p.targetAddress}:${p.targetPort}?rtcpport=${p.targetPort}&pkt_size=${p.mtu}`,
  ];
}
