import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FaceCapture from '../FaceCapture';
import { kycService } from '@/lib/services/kycService';

// Mock the kycService
jest.mock('@/lib/services/kycService', () => ({
  kycService: {
    verifyFace: jest.fn(),
    validateDocumentQuality: jest.fn(),
  },
}));

// Mock the MediaDevices API
global.navigator.mediaDevices = {
  getUserMedia: jest.fn().mockResolvedValue({
    getTracks: () => [{
      stop: jest.fn()
    }],
    getVideoTracks: () => [{
      getSettings: () => ({ width: 1280, height: 720 })
    }]
  })
} as any;

describe('FaceCapture Component', () => {
  const mockOnFaceVerified = jest.fn();
  const mockOnError = jest.fn();
  
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  it('renders correctly with initial state', () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Check if the component renders
    expect(screen.getByText('打开相机')).toBeInTheDocument();
  });
  
  it('handles camera open click', async () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Click open camera button
    fireEvent.click(screen.getByText('打开相机'));
    
    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    });
    
    // Check if start liveness button is displayed
    expect(screen.getByText('开始活体检测')).toBeInTheDocument();
  });
  
  it('handles start liveness detection', async () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Open camera first
    fireEvent.click(screen.getByText('打开相机'));
    
    await waitFor(() => {
      expect(screen.getByText('开始活体检测')).toBeInTheDocument();
    });
    
    // Click start liveness button
    fireEvent.click(screen.getByText('开始活体检测'));
    
    // Check if instruction is updated
    expect(screen.getByText('请直视摄像头')).toBeInTheDocument();
    
    // Check if next step button is displayed
    expect(screen.getByText('下一步')).toBeInTheDocument();
  });
  
  it('handles liveness steps', async () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Open camera and start liveness
    fireEvent.click(screen.getByText('打开相机'));
    
    await waitFor(() => {
      expect(screen.getByText('开始活体检测')).toBeInTheDocument();
    });
    
    fireEvent.click(screen.getByText('开始活体检测'));
    
    await waitFor(() => {
      expect(screen.getByText('下一步')).toBeInTheDocument();
    });
    
    // Click next step
    fireEvent.click(screen.getByText('下一步'));
    
    // Check if instruction is updated
    expect(screen.getByText('请缓慢眨眼')).toBeInTheDocument();
  });
  
  it('handles face verification', async () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Mock validation
    (kycService.validateDocumentQuality as jest.Mock).mockResolvedValue(85);
    
    // Mock verification result
    const mockVerificationResult = {
      success: true,
      confidence_score: 95.5,
      liveness_detected: true,
      face_id: 'test-face-id'
    };
    (kycService.verifyFace as jest.Mock).mockResolvedValue(mockVerificationResult);
    
    // Open camera, start liveness, complete steps
    fireEvent.click(screen.getByText('打开相机'));
    
    await waitFor(() => {
      expect(screen.getByText('开始活体检测')).toBeInTheDocument();
    });
    
    fireEvent.click(screen.getByText('开始活体检测'));
    
    await waitFor(() => {
      expect(screen.getByText('下一步')).toBeInTheDocument();
    });
    
    // Mock completing all liveness steps
    fireEvent.click(screen.getByText('下一步'));
    await waitFor(() => {
      fireEvent.click(screen.getByText('下一步'));
    });
    await waitFor(() => {
      fireEvent.click(screen.getByText('下一步'));
    });
    
    // Wait for capture button to appear
    await waitFor(() => {
      expect(screen.getByText('拍摄人脸')).toBeInTheDocument();
    });
    
    // Click capture button
    fireEvent.click(screen.getByText('拍摄人脸'));
    
    await waitFor(() => {
      expect(kycService.verifyFace).toHaveBeenCalled();
    });
    
    await waitFor(() => {
      expect(mockOnFaceVerified).toHaveBeenCalledWith(mockVerificationResult);
    });
  });
  
  it('handles verification error', async () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Mock validation
    (kycService.validateDocumentQuality as jest.Mock).mockResolvedValue(85);
    
    // Mock verification error
    const mockError = new Error('Face verification failed');
    (kycService.verifyFace as jest.Mock).mockRejectedValue(mockError);
    
    // Open camera, start liveness, complete steps
    fireEvent.click(screen.getByText('打开相机'));
    
    await waitFor(() => {
      expect(screen.getByText('开始活体检测')).toBeInTheDocument();
    });
    
    fireEvent.click(screen.getByText('开始活体检测'));
    
    await waitFor(() => {
      expect(screen.getByText('下一步')).toBeInTheDocument();
    });
    
    // Mock completing all liveness steps
    fireEvent.click(screen.getByText('下一步'));
    await waitFor(() => {
      fireEvent.click(screen.getByText('下一步'));
    });
    await waitFor(() => {
      fireEvent.click(screen.getByText('下一步'));
    });
    
    // Wait for capture button to appear
    await waitFor(() => {
      expect(screen.getByText('拍摄人脸')).toBeInTheDocument();
    });
    
    // Click capture button
    fireEvent.click(screen.getByText('拍摄人脸'));
    
    await waitFor(() => {
      expect(mockOnError).toHaveBeenCalledWith(mockError);
    });
  });
  
  it('handles camera close', async () => {
    render(
      <FaceCapture
        applicationId="test-app-id"
        onFaceVerified={mockOnFaceVerified}
        onError={mockOnError}
      />
    );
    
    // Open camera
    fireEvent.click(screen.getByText('打开相机'));
    
    await waitFor(() => {
      expect(screen.getByText('关闭相机')).toBeInTheDocument();
    });
    
    // Click close camera button
    fireEvent.click(screen.getByText('关闭相机'));
    
    // Check if camera is closed
    expect(screen.getByText('打开相机')).toBeInTheDocument();
  });
});
