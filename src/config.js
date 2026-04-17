import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 4000,
  ocr: {
    serviceUrl: process.env.OCR_SERVICE_URL,
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT_URL,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    bucket: process.env.S3_BUCKET_NAME,
    region: process.env.S3_REGION || 'auto'
  },
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024,
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    allowedMimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'image/webp',
      'text/plain',  // Added for clinical text paste functionality
      'application/msword',                                                          // .doc files
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'     // .docx files
    ]
  }
};
