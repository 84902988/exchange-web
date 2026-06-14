'use client';

import { useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getKycStatus, applyKyc, uploadKycDocument, getKycResult } from '@/lib/api';
import type { KycDocumentUploadRequest } from '@/lib/api';
import UserSidebar from '@/components/user/UserSidebar';

export default function KycPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [selectedLevel] = useState(1);
  const [personalInfo, setPersonalInfo] = useState({
    first_name: '',
    last_name: '',
    dob: '',
    nationality: '',
    address: {
      street: '',
      city: '',
      state: '',
      country: '',
      postal_code: '',
    },
  });
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File>>({});
  const [applicationId, setApplicationId] = useState<string>('');
  const [, setShowApplyForm] = useState(false);
  
  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };
  
  const { 
    isLoading: isLoadingKycStatus, 
    refetch: refetchKycStatus 
  } = useQuery({
    queryKey: ['kycStatus'],
    queryFn: getKycStatus,
    staleTime: 1000 * 60 * 5,
    throwOnError: false,
  });

  const { 
    mutate: submitKycApplication
  } = useMutation({
    mutationFn: applyKyc,
    onSuccess: (data) => {
      setApplicationId(data.application_id);
      setShowApplyForm(false);
      refetchKycStatus();
    },
  });

  const { 
    mutate: uploadDocument
  } = useMutation({
    mutationFn: ({ application_id, document_type, file, file_side }: KycDocumentUploadRequest) => {
      return uploadKycDocument(application_id, document_type, file, file_side);
    },
    onSuccess: () => {
      refetchKycStatus();
    },
  });

  useQuery({
    queryKey: ['kycResult', applicationId],
    queryFn: () => getKycResult(applicationId),
    enabled: !!applicationId,
    staleTime: 1000 * 60 * 5,
    throwOnError: false,
  });

  const handleApplyKyc = () => {
    submitKycApplication({
      level: selectedLevel,
      personal_info: personalInfo,
    });
  };

  const handleFileChange = (documentType: string, file: File) => {
    setSelectedFiles(prev => ({
      ...prev,
      [documentType]: file,
    }));
  };

  const handleUploadFiles = () => {
    if (!applicationId) return;
    
    Object.entries(selectedFiles).forEach(([documentType, file]) => {
      uploadDocument({
        application_id: applicationId,
        document_type: documentType as KycDocumentUploadRequest["document_type"],
        file,
        file_side: documentType === 'id_card' ? 'front' : undefined,
      });
    });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name.includes('.')) {
      const [parent, child] = name.split('.');
      if (parent === 'address') {
        setPersonalInfo(prev => ({
          ...prev,
          [parent]: {
            ...prev.address,
            [child]: value,
          },
        }));
      }
    } else {
      setPersonalInfo(prev => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  const getKycStatusText = (status: string) => {
    const statusKeyMap: Record<string, string> = {
      pending: 'kycStatusSubmitPendingBadge',
      under_review: 'kycStatusPendingBadge',
      approved: 'kycStatusApprovedBadge',
      rejected: 'kycStatusRejectedBadge',
      expired: 'kycStatusExpiredBadge',
    };
    const key = statusKeyMap[status];
    return key ? t(key, 'user') : status;
  };

  void handleApplyKyc;
  void handleFileChange;
  void handleUploadFiles;
  void handleInputChange;
  void getKycStatusText;

  if (isLoadingKycStatus) {
    return (
      <main className="min-h-screen py-8 flex bg-[#0a0a0d]">
        <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
        <div className="lg:w-4/5 w-full px-4">
          <div className="container mx-auto px-4">
            <h1 className="text-2xl font-bold text-white mb-6">{t('kycPageTitle', 'user')}</h1>
            <div className="rounded-lg p-6 bg-[#0a0a0d] text-center">
              <div className="text-white/70">{t('loading', 'common')}</div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-8 flex">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
      
      <div className="lg:w-4/5 w-full px-4">
        <div className="container mx-auto px-4">
          <h1 className="text-2xl font-bold text-white mb-6">{t('kycPageTitle', 'user')}</h1>
          
          <div className="rounded-lg p-6 bg-black">
            <div className="text-center py-16">
              <div className="w-20 h-20 bg-gray-700 rounded-full mx-auto mb-6 flex items-center justify-center">
                <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-3">{t('featureNotAvailable', 'common')}</h2>
              <p className="text-sm text-white/70">{t('underDevelopmentDesc', 'common')}</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
