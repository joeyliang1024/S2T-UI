export const importExtensions = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'webm', 'flac', 'mp4', 'mov', 'mpeg', 'mpg', 'mpga', 'opus', 'mkv', 'avi', 'aiff', 'aif', 'wma'] as const
export const importFileAccept = importExtensions.map(extension => `.${extension}`).join(',')
