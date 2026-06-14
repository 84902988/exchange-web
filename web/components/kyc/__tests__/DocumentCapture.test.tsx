import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DocumentCapture from '../DocumentCapture';
import { kycService } from '@/lib/services/kycService';

// Mock the kycService
jest.mock('@/lib/services/kycService', () => ({
  kycService: {
    verifyDocument: jest.fn(),
    validateDocumentQuality: jest.fn(),
    getSupportedDocumentTypes: jest.fn(() => [
      { type: 'passport', name: 'Passport', requiresBackSide: false },
      { type: 'id_card', name: 'Identity Card', requiresBackSide: true },
    ]),
  },
}));

describe('DocumentCapture Component', () => {
  const mockOnDocumentVerified = jest.fn();
  const mockOnError = jest.fn();
  
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  it('renders correctly with initial state', () => {
    render(
      <DocumentCapture
        applicationId="test-app-id"
        countryCode="CN"
        onDocumentVerified={mockOnDocumentVerified}
        onError={mockOnError}
      />
    );
    
    // Check if the component renders
    expect(screen.getByText('证件类型')).toBeInTheDocument();
    expect(screen.getByText('选择文件')).toBeInTheDocument();
    expect(screen.getByText('拍摄照片')).toBeInTheDocument();
  });
  
  it('handles document type change', () => {
    render(
      <DocumentCapture
        applicationId="test-app-id"
        countryCode="CN"
        onDocumentVerified={mockOnDocumentVerified}
        onError={mockOnError}
      />
    );
    
    const select = screen.getByLabelText('证件类型');
    fireEvent.change(select, { target: { value: 'id_card' } });
    
    expect(select.value).toBe('id_card');
  });
  
  it('handles file selection', async () => {
    render(
      <DocumentCapture
        applicationId="test-app-id"
        countryCode="CN"
        onDocumentVerified={mockOnDocumentVerified}
        onError={mockOnError}
      />
    );
    
    // Mock file
    const file = new File(['test-content'], 'test.jpg', { type: 'image/jpeg' });
    
    // Mock the file input
    const fileInput = screen.getByLabelText(/选择文件/i).closest('button')?.nextElementSibling as HTMLInputElement;
    
    // Mock validation
    (kycService.validateDocumentQuality as jest.Mock).mockResolvedValue(80);
    
    // Trigger file change
    fireEvent.change(fileInput, { target: { files: [file] } });
    
    await waitFor(() => {
      expect(kycService.validateDocumentQuality).toHaveBeenCalledWith(file);
    });
    
    // Check if preview is displayed
    expect(screen.getByAltText('Document Preview')).toBeInTheDocument();
  });
  
  it('shows error for low quality document', async () => {
    render(
      <DocumentCapture
        applicationId="test-app-id"
        countryCode="CN"
        onDocumentVerified={mockOnDocumentVerified}
        onError={mockOnError}
      />
    );
    
    // Mock file
    const file = new File(['test-content'], 'test.jpg', { type: 'image/jpeg' });
    
    // Mock the file input
    const fileInput = screen.getByLabelText(/选择文件/i).closest('button')?.nextElementSibling as HTMLInputElement;
    
    // Mock validation with low score
    (kycService.validateDocumentQuality as jest.Mock).mockResolvedValue(40);
    
    // Trigger file change
    fireEvent.change(fileInput, { target: { files: [file] } });
    
    await waitFor(() => {
      expect(kycService.validateDocumentQuality).toHaveBeenCalledWith(file);
    });
    
    // Check if error is displayed
    expect(screen.getByText('文档质量较低，请重新拍摄或选择更清晰的照片')).toBeInTheDocument();
  });
  
  it('handles verification button click', async () => {
    render(
      <DocumentCapture
        applicationId="test-app-id"
        countryCode="CN"
        onDocumentVerified={mockOnDocumentVerified}
        onError={mockOnError}
      />
    );
    
    // Mock file
    const file = new File(['test-content'], 'test.jpg', { type: 'image/jpeg' });
    
    // Mock the file input
    const fileInput = screen.getByLabelText(/选择文件/i).closest('button')?.nextElementSibling as HTMLInputElement;
    
    // Mock validation
    (kycService.validateDocumentQuality as jest.Mock).mockResolvedValue(80);
    
    // Mock verification
    const mockVerificationResult = {
      success: true,
      document_type: 'passport',
      country: 'CN',
      extracted_data: {
        first_name: 'Test',
        last_name: 'User',
        date_of_birth: '1990-01-01',
        document_number: 'TEST123456'
      },
      image_quality: 85,
      tampering_detected: false
    };
    (kycService.verifyDocument as jest.Mock).mockResolvedValue(mockVerificationResult);
    
    // Trigger file change
    fireEvent.change(fileInput, { target: { files: [file] } });
    
    await waitFor(() => {
      expect(screen.getByText('验证证件')).toBeInTheDocument();
    });
    
    // Click verify button
    fireEvent.click(screen.getByText('验证证件'));
    
    await waitFor(() => {
      expect(kycService.verifyDocument).toHaveBeenCalled();
    });
    
    await waitFor(() => {
      expect(mockOnDocumentVerified).toHaveBeenCalledWith(mockVerificationResult);
    });
  });
  
  it('handles verification error', async () => {
    render(
      <DocumentCapture
        applicationId="test-app-id"
        countryCode="CN"
        onDocumentVerified={mockOnDocumentVerified}
        onError={mockOnError}
      />
    );
    
    // Mock file
    const file = new File(['test-content'], 'test.jpg', { type: 'image/jpeg' });
    
    // Mock the file input
    const fileInput = screen.getByLabelText(/选择文件/i).closest('button')?.nextElementSibling as HTMLInputElement;
    
    // Mock validation
    (kycService.validateDocumentQuality as jest.Mock).mockResolvedValue(80);
    
    // Mock verification error
    const mockError = new Error('Verification failed');
    (kycService.verifyDocument as jest.Mock).mockRejectedValue(mockError);
    
    // Trigger file change
    fireEvent.change(fileInput, { target: { files: [file] } });
    
    await waitFor(() => {
      expect(screen.getByText('验证证件')).toBeInTheDocument();
    });
    
    // Click verify button
    fireEvent.click(screen.getByText('验证证件'));
    
    await waitFor(() => {
      expect(mockOnError).toHaveBeenCalledWith(mockError);
    });
  });
});
