// KYC服务集成层
// 封装与第三方KYC服务商的交互逻辑

import { 
  verifyFace, 
  verifyDocument, 
  getKycVerificationResult, 
  FaceVerificationRequest, 
  KycDocumentUploadRequest, 
  FaceVerificationResult, 
  DocumentVerificationResult, 
  KycVerificationResult 
} from '../api';

// 第三方KYC服务商配置
interface KycProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
}

// KYC服务类
export class KycService {
  private config: KycProviderConfig;
  
  constructor(config?: Partial<KycProviderConfig>) {
    this.config = {
      apiKey: process.env.NEXT_PUBLIC_KYC_API_KEY || '',
      baseUrl: process.env.NEXT_PUBLIC_KYC_BASE_URL || 'https://api.kyc-provider.com',
      timeout: 30000,
      ...config
    };
  }
  
  /**
   * 人脸验证
   * @param data 人脸验证请求数据
   * @returns 人脸验证结果
   */
  async verifyFace(data: FaceVerificationRequest): Promise<FaceVerificationResult> {
    try {
      // 这里可以添加服务商特定的处理逻辑
      // 例如：转换数据格式、添加服务商特定参数等
      
      const result = await verifyFace(data);
      
      // 可以添加结果转换或日志记录
      return result;
    } catch (error) {
      console.error('人脸验证失败:', error);
      throw error;
    }
  }
  
  /**
   * 证件验证
   * @param data 证件验证请求数据
   * @returns 证件验证结果
   */
  async verifyDocument(data: KycDocumentUploadRequest): Promise<DocumentVerificationResult> {
    try {
      // 这里可以添加服务商特定的处理逻辑
      // 例如：根据国家代码选择不同的验证模板
      
      const result = await verifyDocument(data);
      
      // 可以添加结果转换或日志记录
      return result;
    } catch (error) {
      console.error('证件验证失败:', error);
      throw error;
    }
  }
  
  /**
   * 获取完整KYC验证结果
   * @param applicationId KYC申请ID
   * @returns 完整KYC验证结果
   */
  async getVerificationResult(applicationId: string): Promise<KycVerificationResult> {
    try {
      const result = await getKycVerificationResult(applicationId);
      return result;
    } catch (error) {
      console.error('获取KYC验证结果失败:', error);
      throw error;
    }
  }
  
  /**
   * 验证文档质量
   * @param file 文档文件
   * @returns 文档质量评分 (0-100)
   */
  async validateDocumentQuality(file: File): Promise<number> {
    // 实现文档质量验证逻辑
    // 可以使用前端库（如TensorFlow.js）或调用第三方API
    try {
      // 这里实现简单的质量验证，实际项目中可以替换为更复杂的逻辑
      const img = new Image();
      const url = URL.createObjectURL(file);
      
      return new Promise((resolve) => {
        img.onload = () => {
          // 简单的质量评分：基于分辨率
          const minResolution = 1280 * 720;
          const actualResolution = img.width * img.height;
          const resolutionScore = Math.min(100, (actualResolution / minResolution) * 100);
          
          // 基于文件大小（假设100KB-5MB为最佳）
          const minSize = 100 * 1024; // 100KB
          const maxSize = 5 * 1024 * 1024; // 5MB
          const sizeScore = Math.min(100, Math.max(0, (file.size - minSize) / (maxSize - minSize) * 100));
          
          // 综合评分
          const qualityScore = Math.round((resolutionScore + sizeScore) / 2);
          
          URL.revokeObjectURL(url);
          resolve(qualityScore);
        };
        
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(0); // 无法加载图片，质量为0
        };
        
        img.src = url;
      });
    } catch (error) {
      console.error('文档质量验证失败:', error);
      return 0;
    }
  }
  
  /**
   * 获取支持的证件类型
   * @param countryCode 国家代码（可选）
   * @returns 支持的证件类型列表
   */
  getSupportedDocumentTypes(countryCode?: string): Array<{
    type: KycDocumentUploadRequest['document_type'];
    name: string;
    requiresBackSide: boolean;
  }> {
    // 基础证件类型列表
    const baseTypes: Array<{ type: "id_card" | "passport" | "driver_license" | "utility_bill" | "residence_permit" | "national_id" | "military_id" | "student_id"; name: string; requiresBackSide: boolean }> = [
      { type: 'id_card', name: 'ID Card', requiresBackSide: true },
      { type: 'passport', name: 'Passport', requiresBackSide: false },
      { type: 'driver_license', name: 'Driver License', requiresBackSide: true },
      { type: 'utility_bill', name: 'Utility Bill', requiresBackSide: false },
      { type: 'residence_permit', name: 'Residence Permit', requiresBackSide: true },
      { type: 'national_id', name: 'National ID', requiresBackSide: true },
      { type: 'military_id', name: 'Military ID', requiresBackSide: true },
      { type: 'student_id', name: 'Student ID', requiresBackSide: false },
    ];
    
    // 可以根据国家代码返回特定的证件类型
    // 例如：某些国家可能不支持特定类型
    if (countryCode) {
      // 这里可以添加国家特定的逻辑
      return baseTypes;
    }
    
    return baseTypes;
  }
}

// 创建单例实例
export const kycService = new KycService();
