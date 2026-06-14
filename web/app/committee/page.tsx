'use client';

import React from 'react';
import useLocale from '@/hooks/useLocale';
import Image from 'next/image';
// 移除motion库导入，使用CSS动画替代

const CommitteePage: React.FC = () => {
  const { t, locale, translations } = useLocale();
  const [selectedMember, setSelectedMember] = React.useState<any>(null);
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  
  React.useEffect(() => {
    if (isModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    
    //组件卸载时兜底恢复（防止异常状态）
    return () => {
      document.body.style.overflow = '';
    };
  }, [isModalOpen]);

  // 获取本地化的成员数据
  const members = Array.isArray(translations.committee.members) ? translations.committee.members : [];
  const memberPlaceholder = t('memberPlaceholder', 'committee');

  // 打开弹窗
  const openModal = (member: any) => {
    setSelectedMember(member);
    setIsModalOpen(true);
  };

  // 关闭弹窗
  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedMember(null);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0d] py-12 px-4">
      <div className="max-w-7xl mx-auto">
        {/* 页面标题 - 随语言选择变化 */}
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-white mb-4">{t('title', 'committee') as string}</h1>
          <div className="w-24 h-1 bg-amber-500 mx-auto"></div>
        </div>

        {/* 委员会介绍 */}
        <div className="text-center mb-16 max-w-3xl mx-auto">
          <p className="text-white/80 text-lg leading-relaxed mb-4">
            {t('introLine1', 'committee') as string}
          </p>
          <p className="text-white/80 text-lg leading-relaxed">
            {t('introLine2', 'committee') as string}
          </p>
        </div>

        {/* 成员展示区域 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {/* 动态渲染成员卡片 */}
          {members.map((member: any, index: number) => (
            <div key={index} className="space-y-4 w-[85%] mx-auto">
              {/* 图片卡片 - 外框与图片尺寸相同 */}
              <div className="relative aspect-[4/5] w-full cursor-pointer overflow-hidden group" onClick={() => openModal(member)}>
                {/* 使用Next.js Image组件 */}
                {member.image ? (
                  <>
                    <Image
                      src={member.image}
                      alt={member.name}
                      fill
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 pointer-events-none transition-all duration-300 group-hover:shadow-[0_0_0_2px_rgba(245,158,11,0.8)]" />
                  </>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-white/50 text-xl">
                    {memberPlaceholder} {index + 1}
                  </div>
                )}
             </div>
              
              {/* 文字区域 - 移到卡片下方 */}
              <div className="text-center space-y-2">
                {/* 职位 */}
                <div className="text-amber-500 text-xs font-semibold uppercase tracking-wider">
                  {member.position}
                </div>
                
                {/* 姓名 */}
                <h3 className="text-xl font-bold text-white">{member.name}</h3>
                

              </div>
            </div>
          ))}
        </div>
      </div>
      
      {/* 成员详情弹窗 */}
      <div className={`fixed inset-0 flex items-center justify-center z-50 overflow-y-auto hide-scrollbar p-4 transition-all duration-300 ease-in-out ${isModalOpen ? 'bg-black/80 opacity-100 pointer-events-auto' : 'bg-black/0 opacity-0 pointer-events-none'}`} onClick={closeModal}>
        {selectedMember && (
          <div className={`relative w-full max-w-6xl h-[90vh] bg-gray-900 rounded-lg overflow-hidden shadow-2xl transition-all duration-500 ease-in-out transform ${isModalOpen ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`} onClick={(e) => e.stopPropagation()}>
              {/* 关闭按钮 */}
              <button 
                onClick={closeModal}
                className="absolute top-4 right-4 text-white hover:text-amber-400 transition-colors duration-200 z-10"
                aria-label="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              
              {/* 弹窗内容布局 */}
              <div className="flex flex-col md:flex-row h-full">
                {/* 左侧文字内容区 */}
                <div className="w-full md:w-1/2 p-8 md:p-16 text-white flex flex-col overflow-y-auto hide-scrollbar">
                  {/* 职位 */}
                  <div className="inline-block bg-amber-500 text-black text-xs font-semibold uppercase tracking-wider px-3 py-1 mb-4">
                    {selectedMember.position}
                  </div>
                  
                  {/* 英文姓名 */}
                  <h2 className="text-3xl font-bold mb-2">{selectedMember.name}</h2>
                  
                  {/* 中文姓名（如果有） */}
                  {/* 这里可以根据需要添加中文姓名，目前数据中可能没有 */}
                  
                  {/* 详细介绍 */}
                  <div className="mt-6 space-y-6">
                    {/* 插图（仅当存在时显示）*/}
                    {/* 新增修改-2026.1.19-添加了人物详情卡内的单个插图*/}
                    {selectedMember.illustration && (
                      <div className="relative w-full overflow-hidden rounded-lg bg-black/20 flex items-center justify-center">
                        <Image
                          src={selectedMember.illustration}
                          alt={`${selectedMember.name} illustration`}
                          width={800}
                          height={800}
                          className="max-h-[160px] w-auto object-contain"
                          priority
                        />
                      </div>
                    )}
                    
                    {/* 新增修改-2026.1.20-人物详情卡内多图或图集*/}
                    {Array.isArray(selectedMember.illustrations) && (
                      <div className="space-y-6">
                        {selectedMember.illustrations.map((img: any, i: number) => (
                        <div
                          key={i}
                          className={`relative w-full overflow-hidden rounded-lg ${
                            img.aspect === '1/1'
                              ? 'aspect-square'
                              : img.aspect === '16/9'
                              ? 'aspect-video'
                              : 'aspect-[3/4]'
                              }`}
                            >
                            <Image
                              src={img.src}
                              alt={`${selectedMember.name} image ${i + 1}`}
                              fill
                              className="object-contain"
                            />
                           </div>
                         ))}
                       </div>
                     )}


                    <div className="text-sm md:text-base leading-relaxed tracking-wide">
                      {/* 使用dangerouslySetInnerHTML处理HTML标签 */}
                      <p dangerouslySetInnerHTML={{ __html: selectedMember.bio }} />
                    </div>
                    {/* 可以根据需要添加更多内容 */}
                  </div>
                </div>
                
                {/* 右侧图片区 */}
                <div className="w-full md:w-1/2 relative h-full">
                  {selectedMember.image && (
                    <Image
                      src={selectedMember.image}
                      alt={selectedMember.name}
                      fill
                      className="object-cover"
                    />
                  )}
                </div>
              </div>
            </div>
        )}
      </div>
    </div>
  );
};

export default CommitteePage;