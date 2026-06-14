'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useLocale from '@/hooks/useLocale';
import UserSidebar from '@/components/user/UserSidebar';

// 密码设置表单数据类型
interface PasswordFormData {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

// 密码强度类型
interface PasswordStrength {
  valid: boolean;
  hasLowercase: boolean;
  hasUppercase: boolean;
  hasNumber: boolean;
  hasSpecialChar: boolean;
  lengthValid: boolean;
}

export default function PasswordPage() {
  const { t } = useLocale();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const router = useRouter();
  
  // 表单状态管理
  const [formData, setFormData] = useState<PasswordFormData>({
    oldPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  
  // 错误状态管理
  const [errors, setErrors] = useState<Partial<PasswordFormData>>({});
  
  // 提交状态管理
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  
  // 密码强度状态管理
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength>({
    valid: false,
    hasLowercase: false,
    hasUppercase: false,
    hasNumber: false,
    hasSpecialChar: false,
    lengthValid: false,
  });
  
  // 切换侧边栏折叠状态
  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };
  
  // 密码强度验证
  const checkPasswordStrength = (password: string): PasswordStrength => {
    const hasLowercase = /[a-z]/.test(password);
    const hasUppercase = /[A-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    const lengthValid = password.length >= 8;
    
    const valid = hasLowercase && hasUppercase && hasNumber && hasSpecialChar && lengthValid;
    
    return {
      valid,
      hasLowercase,
      hasUppercase,
      hasNumber,
      hasSpecialChar,
      lengthValid,
    };
  };
  
  // 处理表单输入变化
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    
    // 更新密码强度
    if (name === 'newPassword') {
      setPasswordStrength(checkPasswordStrength(value));
    }
    
    // 清除对应字段的错误
    if (errors[name as keyof PasswordFormData]) {
      setErrors(prev => ({
        ...prev,
        [name]: undefined
      }));
    }
  };
  
  // 表单验证
  const validateForm = (): boolean => {
    const newErrors: Partial<PasswordFormData> = {};
    
    // 验证旧密码
    if (!formData.oldPassword.trim()) {
      newErrors.oldPassword = t('required', 'common');
    }
    
    // 验证新密码
    if (!formData.newPassword.trim()) {
      newErrors.newPassword = t('required', 'common');
    } else {
      const strength = checkPasswordStrength(formData.newPassword);
      if (!strength.valid) {
        newErrors.newPassword = t('passwordStrengthError', 'auth');
      }
    }
    
    // 验证确认密码
    if (!formData.confirmPassword.trim()) {
      newErrors.confirmPassword = t('required', 'common');
    } else if (formData.confirmPassword !== formData.newPassword) {
      newErrors.confirmPassword = t('passwordsNotMatch', 'auth');
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };
  
  // 处理表单提交
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }
    
    setIsSubmitting(true);
    setSuccess(false);
    
    try {
      // 模拟API请求延迟
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 调用实际的密码更新API
      console.log('密码更新请求:', formData);
      
      // 显示成功消息
      setSuccess(true);
      setSuccessMessage(t('passwordUpdatedSuccessfully', 'auth'));
      
      // 重置表单
      setFormData({
        oldPassword: '',
        newPassword: '',
        confirmPassword: ''
      });
      
      // 密码更新成功后，要求用户重新登录
      // 这里应该调用实际的登出API，然后跳转到登录页面
      setTimeout(() => {
        // 登出并跳转到登录页面
        window.location.href = '/login';
      }, 2000);
    } catch (error) {
      console.error('密码更新失败:', error);
      // 这里应该显示错误消息
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen py-8 flex bg-[#0a0a0d]">
      {/* 左侧用户中心专属侧边栏 */}
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
      
      {/* 右侧主要内容 */}
      <div className={`lg:w-${isSidebarCollapsed ? '4/5' : '4/5'} w-full px-4 bg-[#0a0a0d] py-10`}>
        <div className="max-w-7xl mx-auto">
          {/* 页面标题 */}
          <h1 className="text-3xl font-bold text-white/90 mb-8">
            {t('passwordSettings', 'user')}
          </h1>
          
          {/* 密码设置卡片 */}
          <div className="bg-[#0a0a0d] rounded-lg p-6 border border-white/10">
            {/* 成功消息 */}
            {success && (
              <div className="bg-green-500/20 text-green-400 p-3 rounded-md mb-6">
                {successMessage}
              </div>
            )}
            
            {/* 密码设置表单 */}
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* 旧密码 */}
              <div>
                <label htmlFor="oldPassword" className="block text-sm font-medium text-white/90 mb-2">
                  {t('oldPassword', 'auth')}
                </label>
                <input
                  type="password"
                  id="oldPassword"
                  name="oldPassword"
                  value={formData.oldPassword}
                  onChange={handleInputChange}
                  disabled={isSubmitting}
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  placeholder={t('enterOldPassword', 'auth')}
                />
                {errors.oldPassword && (
                  <p className="mt-2 text-sm text-red-400">{errors.oldPassword}</p>
                )}
              </div>
              
              {/* 新密码 */}
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium text-white/90 mb-2">
                  {t('newPassword', 'auth')}
                </label>
                <input
                  type="password"
                  id="newPassword"
                  name="newPassword"
                  value={formData.newPassword}
                  onChange={handleInputChange}
                  disabled={isSubmitting}
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  placeholder={t('enterNewPassword', 'auth')}
                />
                {errors.newPassword && (
                  <p className="mt-2 text-sm text-red-400">{errors.newPassword}</p>
                )}
                
                {/* 密码强度指示器 */}
                <div className="mt-3 text-xs">
                  <p className="text-white/70 mb-2">{t('passwordRequirements', 'auth')}</p>
                  <ul className="space-y-1">
                    <li className={`flex items-center gap-2 ${passwordStrength.lengthValid ? 'text-green-400' : 'text-red-400'}`}>
                      <span>{passwordStrength.lengthValid ? '✓' : '✗'}</span>
                      <span>{t('passwordLength', 'auth')}</span>
                    </li>
                    <li className={`flex items-center gap-2 ${passwordStrength.hasLowercase ? 'text-green-400' : 'text-red-400'}`}>
                      <span>{passwordStrength.hasLowercase ? '✓' : '✗'}</span>
                      <span>{t('passwordLowercase', 'auth')}</span>
                    </li>
                    <li className={`flex items-center gap-2 ${passwordStrength.hasUppercase ? 'text-green-400' : 'text-red-400'}`}>
                      <span>{passwordStrength.hasUppercase ? '✓' : '✗'}</span>
                      <span>{t('passwordUppercase', 'auth')}</span>
                    </li>
                    <li className={`flex items-center gap-2 ${passwordStrength.hasNumber ? 'text-green-400' : 'text-red-400'}`}>
                      <span>{passwordStrength.hasNumber ? '✓' : '✗'}</span>
                      <span>{t('passwordNumber', 'auth')}</span>
                    </li>
                    <li className={`flex items-center gap-2 ${passwordStrength.hasSpecialChar ? 'text-green-400' : 'text-red-400'}`}>
                      <span>{passwordStrength.hasSpecialChar ? '✓' : '✗'}</span>
                      <span>{t('passwordSpecial', 'auth')}</span>
                    </li>
                  </ul>
                </div>
              </div>
              
              {/* 确认新密码 */}
              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-white/90 mb-2">
                  {t('confirmPassword', 'auth')}
                </label>
                <input
                  type="password"
                  id="confirmPassword"
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  disabled={isSubmitting}
                  className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  placeholder={t('confirmNewPassword', 'auth')}
                />
                {errors.confirmPassword && (
                  <p className="mt-2 text-sm text-red-400">{errors.confirmPassword}</p>
                )}
              </div>
              
              {/* 提交按钮 */}
              <div className="pt-4">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white font-medium py-3 px-4 rounded-md transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? t('updating', 'common') : t('updatePassword', 'user')}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
