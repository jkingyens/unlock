// ext/cloud-storage.js
/**
 * Simple Cloud Storage client (S3-compatible) for the Unpack extension
 * Supports Digital Ocean Spaces, AWS S3, and Google Cloud Storage
 * Uses AWS SDK-compatible V4 signing with access key ID and secret
 */

import { logger, storage } from './utils.js'; // Use utils for storage access

// --- STATELESS HELPER ---
function constructPublicUrl(filePath, publishContext) {
    if (!filePath || !publishContext || !publishContext.provider || !publishContext.bucket) {
        logger.warn('CloudStorage:constructPublicUrl', 'Cannot construct URL, missing required context', { filePath, publishContext });
        return null;
    }
    const { provider, bucket, region } = publishContext;
    const cleanFilePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;

    if (provider === 'digitalocean') {
        return `https://${bucket}.${region}.digitaloceanspaces.com/${cleanFilePath}`;
    } else if (provider === 's3') {
        return `https://${bucket}.s3.${region}.amazonaws.com/${cleanFilePath}`;
    } else if (provider === 'google') {
        return `https://storage.googleapis.com/${bucket}/${cleanFilePath}`;
    }
    logger.warn('CloudStorage:constructPublicUrl', 'Unknown provider type in context', { provider });
    return null;
}


const cloudStorage = {
  providerType: null, // 'digitalocean', 's3', or 'google'
  activeConfig: null, // Holds the active storage configuration object { id, name, provider, credentials, bucket, region }
  initialized: false,
  uploadListeners: [], // Array to hold progress listener callbacks

  async initialize() {
    // The "if (this.initialized) return true;" line is removed.
    try {
      const activeCloudConfig = await storage.getActiveCloudStorageConfig();
      if (!activeCloudConfig || !activeCloudConfig.credentials?.accessKey || !activeCloudConfig.credentials?.secretKey) {
        logger.log('CloudStorage', 'Cloud Storage not enabled or missing credentials/settings in the active configuration.');
        this.initialized = false;
        this.activeConfig = null;
        this.providerType = null;
        return false;
      }
      
      this.activeConfig = activeCloudConfig;
      this.providerType = activeCloudConfig.provider;
      
      logger.log('CloudStorage', `Cloud Storage client initialized for active provider: ${this.providerType}`, { bucketName: this.activeConfig.bucket, region: this.activeConfig.region });
      this.initialized = true;
      return true;

    } catch (error) { 
      logger.error('CloudStorage', 'Initialization error', error); 
      this.initialized = false; 
      return false; 
    }
  },

  addUploadProgressListener(listener) {
    this.uploadListeners.push(listener);
    return () => {
      const index = this.uploadListeners.indexOf(listener);
      if (index !== -1) {
        this.uploadListeners.splice(index, 1);
      }
    };
  },

  notifyUploadProgress(progressData) {
    [...this.uploadListeners].forEach(listener => {
      try { 
        listener(progressData); 
      } catch (error) { 
        logger.error('CloudStorage', 'Error in upload progress listener', error); 
      }
    });
  },
  
 async downloadFile(filePath) {
    if (!(await this.initialize())) { return { success: false, error: 'Client not initialized.' }; }
    if (!filePath) { return { success: false, error: 'Missing required filePath for downloadFile.' }; }
    if (!this.activeConfig.credentials?.accessKey || !this.activeConfig.credentials?.secretKey) { return { success: false, error: 'Missing Access Key or Secret Key in active settings.' }; }

    try {
      const bucketName = this.activeConfig.bucket; 
      const region = this.activeConfig.region;
      const provider = this.providerType;
      const cleanedFilePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;

      let host, endpoint, pathForSigning;
      
      if (provider === 'digitalocean' || provider === 's3') {
        host = provider === 'digitalocean' ? `${bucketName}.${region}.digitaloceanspaces.com` : `${bucketName}.s3.${region}.amazonaws.com`;
        endpoint = `https://${host}/${cleanedFilePath}`;
        pathForSigning = `/${cleanedFilePath}`;
      } else if (provider === 'google') {
        host = 'storage.googleapis.com';
        endpoint = `https://${host}/${bucketName}/${cleanedFilePath}`;
        pathForSigning = `/${bucketName}/${cleanedFilePath}`;
      } else { 
        throw new Error(`Invalid storage provider type: ${provider}`);
      }
      
      const headers = new Headers(); 
      headers.set('Host', host); 

      const authHeader = await this.generateAuthHeader(
        this.activeConfig.credentials.accessKey, this.activeConfig.credentials.secretKey, region, 
        'GET', 
        pathForSigning, 
        headers
      );
      
      headers.append('Authorization', authHeader);

      const response = await fetch(endpoint, { method: 'GET', headers: headers, cache: 'no-store' });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('CloudStorage', 'Download failed', { status: response.status, statusText: response.statusText, error: errorText, filePath: cleanedFilePath });
        return { success: false, error: `Download failed (${response.status}): ${errorText || response.statusText}`, status: response.status };
      }

      logger.log('CloudStorage', 'File downloaded successfully using V4 signature', { filePath: cleanedFilePath });
      
      // --- START OF FIX ---
      // This ensures we get the raw binary data for any file type.
      const contentBuffer = await response.arrayBuffer();
      return { success: true, content: contentBuffer };
      // --- END OF FIX ---

    } catch (error) {
      logger.error('CloudStorage', 'Download error', { filePath, error });
      if (error instanceof SyntaxError) { return { success: false, error: 'Failed to parse downloaded file as JSON.' }; }
      return { success: false, error: error.message || 'Unknown download error' };
    }
  },
  
  async generatePresignedGetUrl(filePath, expirationSeconds = 3600, publishContext, extraQueryParams = {}) {
    if (!publishContext || !publishContext.storageConfigId) {
        logger.error('CloudStorage:generatePresignedGetUrl', 'CRITICAL: publishContext with storageConfigId is required for signing.', { filePath });
        return null;
    }

    const settings = await storage.getSettings();
    const storageConfig = settings.storageConfigs.find(c => c.id === publishContext.storageConfigId);

    if (!storageConfig || !storageConfig.credentials?.accessKey || !storageConfig.credentials?.secretKey) {
        logger.error('CloudStorage:generatePresignedGetUrl', 'Could not find matching/valid storage configuration for the given context.', { publishContext });
        return null;
    }

    const { accessKey, secretKey } = storageConfig.credentials;
    const { provider, region, bucket } = publishContext;

    try {
      const cleanedFilePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
      
      let host, canonicalUriForSigning;

      if (provider === 'google') {
        host = 'storage.googleapis.com';
        canonicalUriForSigning = `/${bucket}/${cleanedFilePath}`;
      } else if (provider === 'digitalocean' || provider === 's3') {
        host = provider === 'digitalocean' ? `${bucket}.${region}.digitaloceanspaces.com` : `${bucket}.s3.${region}.amazonaws.com`;
        canonicalUriForSigning = `/${cleanedFilePath}`;
      } else {
        throw new Error(`Invalid storage provider type: ${provider}`);
      }
      
      const baseUrl = `https://${host}`;

      const date = new Date();
      const amzDate = date.toISOString().replace(/[:\-]|\.\d{3}/g, ''); 
      const dateStamp = amzDate.substring(0, 8); 

      const algorithm = 'AWS4-HMAC-SHA256';
      const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

      const queryParams = {
        'X-Amz-Algorithm': algorithm,
        'X-Amz-Credential': `${accessKey}/${credentialScope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': expirationSeconds.toString(),
        'X-Amz-SignedHeaders': 'host',
        ...extraQueryParams
      };

      const canonicalQueryString = Object.keys(queryParams)
        .sort()
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
        .join('&');

      const canonicalHeadersStr = `host:${host.toLowerCase()}\n`; 
      const signedHeadersList = 'host';
      const canonicalRequest = `GET\n${canonicalUriForSigning}\n${canonicalQueryString}\n${canonicalHeadersStr}\n${signedHeadersList}\nUNSIGNED-PAYLOAD`;
      
      const canonicalRequestHash = await this.sha256(canonicalRequest);
      const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

      const kDate = await this.hmacSha256(`AWS4${secretKey}`, dateStamp);
      const kRegion = await this.hmacSha256(kDate, region);
      const kService = await this.hmacSha256(kRegion, 's3');
      const kSigning = await this.hmacSha256(kService, 'aws4_request');
      const signature = await this.hmacSha256Hex(kSigning, stringToSign);

      const presignedUrl = `${baseUrl}${canonicalUriForSigning}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
      
      logger.log('CloudStorage:generatePresignedGetUrl', 'Pre-signed URL generated successfully with extra params.', { finalUrlPreview: presignedUrl.substring(0,150)+"...", filePath });
      return presignedUrl;

    } catch (error) {
      logger.error('CloudStorage:generatePresignedGetUrl', 'Error generating pre-signed URL with context', { filePath, error, publishContext });
      return null;
    }
  },

  async generateAuthHeader(accessKey, secretKey, region, method, path, headers) {
    try {
      const date = new Date();
      const amzDate = date.toISOString().replace(/[:\-]|\.\d{3}/g, '');
      const dateStamp = amzDate.substring(0, 8);
      
      headers.set('x-amz-date', amzDate);

      if (method === 'PUT') { 
         headers.set('x-amz-content-sha256', 'UNSIGNED-PAYLOAD'); 
      } else { 
         const emptyPayloadHash = await this.sha256(''); 
         headers.set('x-amz-content-sha256', emptyPayloadHash); 
      }

      if (!headers.has('host')) {
        throw new Error("Host header must be set on the headers object passed to generateAuthHeader.");
      }
      
      const canonicalUri = encodeURI(path); 
      const canonicalQueryString = ''; 
      
      let canonicalHeadersStr = ''; 
      let signedHeadersList = '';
      
      const sortedHeaderKeys = Array.from(headers.keys()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      sortedHeaderKeys.forEach(key => { 
          const value = headers.get(key); 
          const lowerKey = key.toLowerCase(); 
          canonicalHeadersStr += `${lowerKey}:${String(value).trim()}\n`; 
          signedHeadersList += `${lowerKey};`; 
      });
      signedHeadersList = signedHeadersList.slice(0, -1); 

      const payloadHash = headers.get('x-amz-content-sha256');
      const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeadersStr}\n${signedHeadersList}\n${payloadHash}`;
      const canonicalRequestHash = await this.sha256(canonicalRequest);

      const algorithm = 'AWS4-HMAC-SHA256'; 
      const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
      const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

      const kDate = await this.hmacSha256(`AWS4${secretKey}`, dateStamp);
      const kRegion = await this.hmacSha256(kDate, region);
      const kService = await this.hmacSha256(kRegion, 's3');
      const kSigning = await this.hmacSha256(kService, 'aws4_request');
      const signature = await this.hmacSha256Hex(kSigning, stringToSign);

      return `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;
    } catch (error) { 
      logger.error('CloudStorage', 'Error generating auth header', {method, path, error}); 
      throw new Error(`Failed to generate auth header: ${error.message}`); 
    }
  },

  async sha256(message) { const data = new TextEncoder().encode(message); const hashBuffer = await crypto.subtle.digest('SHA-256', data); const hashArray = Array.from(new Uint8Array(hashBuffer)); return hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); },
  async hmacSha256(key, message) { const encoder = new TextEncoder(); let keyBuffer = (typeof key === 'string') ? encoder.encode(key) : key; const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)); },
  async hmacSha256Hex(key, message) { const hashBuffer = await this.hmacSha256(key, message); const hashArray = Array.from(new Uint8Array(hashBuffer)); return hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); },

  async uploadFile(filePath, content, contentType = 'application/json', acl = null) {
    if (!(await this.initialize())) { return { success: false, error: 'Client not initialized.' }; }
    if (!filePath || typeof content === 'undefined' || !contentType) { return { success: false, error: 'Missing required parameters for uploadFile.' }; }
    try {
      this.notifyUploadProgress({ fileName: filePath, status: 'started', progress: 0 });
      const bucketName = this.activeConfig.bucket; 
      const region = this.activeConfig.region;
      const cleanedFilePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
      
      let host, endpoint, pathForSigning;

      if (this.providerType === 'digitalocean' || this.providerType === 's3') {
        host = this.providerType === 'digitalocean' ? `${bucketName}.${region}.digitaloceanspaces.com` : `${bucketName}.s3.${region}.amazonaws.com`;
        endpoint = `https://${host}/${cleanedFilePath}`;
        pathForSigning = `/${cleanedFilePath}`;
      } else if (this.providerType === 'google') {
        host = 'storage.googleapis.com';
        endpoint = `https://${host}/${bucketName}/${cleanedFilePath}`;
        pathForSigning = `/${bucketName}/${cleanedFilePath}`;
      } else { 
        throw new Error(`Invalid storage provider type: ${this.providerType}`);
      }
      
      let contentToUpload = (typeof content === 'string') ? new Blob([content], { type: contentType }) : content;

      const headers = new Headers(); 
      headers.append('Content-Type', contentType); 
      headers.append('Host', host); 
      if (acl) { 
        headers.append('x-amz-acl', acl); 
      }

      const authHeader = await this.generateAuthHeader( 
          this.activeConfig.credentials.accessKey, 
          this.activeConfig.credentials.secretKey, 
          region, 
          'PUT', 
          pathForSigning, 
          headers
      );
      headers.append('Authorization', authHeader); 

      const uploadResponse = await fetch(endpoint, { method: 'PUT', headers: headers, body: contentToUpload });
      
      if (!uploadResponse.ok) { 
        const errorText = await uploadResponse.text(); 
        logger.error('CloudStorage:uploadFile', 'Upload failed', {filePath: cleanedFilePath, status: uploadResponse.status, errorText});
        throw new Error(`Upload failed (${uploadResponse.status}): ${errorText || uploadResponse.statusText}`); 
      }
      
      logger.log('CloudStorage', 'File uploaded successfully', { filePath: cleanedFilePath }); 
      this.notifyUploadProgress({ fileName: cleanedFilePath, status: 'completed', progress: 100, url: cleanedFilePath });
      return { success: true, fileName: cleanedFilePath, url: cleanedFilePath }; 
    } catch (error) { 
      logger.error('CloudStorage', 'Upload error', { filePath, error }); 
      this.notifyUploadProgress({ fileName: filePath, status: 'failed', error: error.message || 'Unknown upload error' }); 
      return { success: false, error: error.message || 'Unknown upload error' }; 
    }
  },
  
  async deleteFile(filePath) {
     if (!(await this.initialize())) { return { success: false, error: 'Client not initialized.' }; }
     if (!filePath) { return { success: false, error: 'Missing required filePath for deleteFile.' }; }
    try {
      const bucketName = this.activeConfig.bucket; 
      const region = this.activeConfig.region;
      const cleanedFilePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
      
      let host, endpoint, pathForSigning;

      if (this.providerType === 'digitalocean' || this.providerType === 's3') {
        host = this.providerType === 'digitalocean' ? `${bucketName}.${region}.digitaloceanspaces.com` : `${bucketName}.s3.${region}.amazonaws.com`;
        endpoint = `https://${host}/${cleanedFilePath}`;
        pathForSigning = `/${cleanedFilePath}`;
      } else if (this.providerType === 'google') {
        host = 'storage.googleapis.com';
        endpoint = `https://${host}/${bucketName}/${cleanedFilePath}`;
        pathForSigning = `/${bucketName}/${cleanedFilePath}`;
      } else { 
        throw new Error(`Invalid storage provider type: ${this.providerType}`);
      }
      
      const headers = new Headers(); 
      headers.set('Host', host); 

      const authHeader = await this.generateAuthHeader(
          this.activeConfig.credentials.accessKey, 
          this.activeConfig.credentials.secretKey, 
          region, 
          'DELETE', 
          pathForSigning, 
          headers
      );
      headers.append('Authorization', authHeader);

      const deleteResponse = await fetch(endpoint, { method: 'DELETE', headers: headers });
      if (deleteResponse.status === 204) { 
        logger.log('CloudStorage', 'File deleted successfully', { filePath: cleanedFilePath }); 
        return { success: true, fileName: cleanedFilePath }; 
      }
      else { 
        const errorText = await deleteResponse.text(); 
        logger.warn('CloudStorage', 'Delete unsuccessful or file not found', { status: deleteResponse.status, error: errorText, filePath: cleanedFilePath }); 
        if (deleteResponse.status === 404) {
            return { success: true, message: 'File not found, considered deleted.', fileName: cleanedFilePath, status: 404 };
        }
        return { success: false, error: `Delete failed (${deleteResponse.status}): ${errorText || deleteResponse.statusText}` }; 
      }
    } catch (error) { 
      logger.error('CloudStorage', 'Delete error', { filePath, error }); 
      return { success: false, error: error.message || 'Unknown delete error' }; 
    }
  },

  getPublicUrl(filePath) {
     if (!this.initialized || !this.activeConfig || !this.activeConfig.bucket || !this.activeConfig.region) { 
       logger.warn('CloudStorage:getPublicUrl', 'Cannot get public URL for active config, client not fully initialized or active config missing.', {filePath, initialized: this.initialized, activeConfig: this.activeConfig });
       return null;
     }
     return constructPublicUrl(filePath, this.activeConfig);
  }
};

cloudStorage.constructPublicUrl = constructPublicUrl;
export default cloudStorage;