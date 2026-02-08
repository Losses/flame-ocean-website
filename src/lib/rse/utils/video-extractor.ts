/**
 * Video Extractor Utility
 * Extracts a sequence of frames from a video file.
 */

export async function extractFrames(videoFile: File, count: number): Promise<File[]> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const frames: File[] = [];

        if (!ctx) {
            reject(new Error("Failed to create canvas context"));
            return;
        }

        // Create object URL for the video file
        const videoUrl = URL.createObjectURL(videoFile);
        video.src = videoUrl;
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = "anonymous";

        // Wait for metadata to load (duration, dimensions)
        video.onloadedmetadata = async () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const duration = video.duration;
            const interval = duration / count;

            try {
                for (let i = 0; i < count; i++) {
                    const time = i * interval;
                    await seekToTime(video, time);

                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
                    if (blob) {
                        const fileName = `frame_${String(i + 1).padStart(3, '0')}.png`;
                        const file = new File([blob], fileName, { type: 'image/png' });
                        frames.push(file);
                    }
                }

                resolve(frames);

            } catch (err) {
                reject(err);
            } finally {
                // Cleanup
                URL.revokeObjectURL(videoUrl);
                video.remove();
                canvas.remove();
            }
        };

        video.onerror = () => {
            URL.revokeObjectURL(videoUrl);
            reject(new Error("Failed to load video file"));
        };
    });
}

function seekToTime(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise((resolve) => {
        const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = time;
    });
}
