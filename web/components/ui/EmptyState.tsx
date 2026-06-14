interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  size?: 'small' | 'medium' | 'large';
}

export default function EmptyState({
  title = '暂无数据',
  description = '当前没有可用数据',
  icon,
  action,
  size = 'medium',
}: EmptyStateProps) {
  // 根据size确定样式
  const sizeClasses = {
    small: {
      container: 'p-4',
      icon: 'w-6 h-6',
      title: 'text-sm',
      description: 'text-xs',
      margin: 'mb-2',
    },
    medium: {
      container: 'p-6',
      icon: 'w-12 h-12',
      title: 'text-lg',
      description: 'text-sm',
      margin: 'mb-4',
    },
    large: {
      container: 'p-8',
      icon: 'w-16 h-16',
      title: 'text-xl',
      description: 'text-base',
      margin: 'mb-6',
    },
  };

  const currentSize = sizeClasses[size];

  // 默认使用红色感叹号SVG图标
  const defaultIcon = (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      fill="none" 
      viewBox="0 0 24 24" 
      strokeWidth={1.5} 
      stroke="currentColor" 
      className={`${currentSize.icon} text-red-500`}
    >
      <path 
        strokeLinecap="round" 
        strokeLinejoin="round" 
        d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" 
      />
    </svg>
  );

  return (
    <div className={`flex flex-col items-center justify-center rounded-lg border border-white/10 bg-white/5 ${currentSize.container} text-center`}>
      {icon && <div className={`${currentSize.margin}`}>{icon}</div>}
      {!icon && size !== 'small' && <div className={`${currentSize.margin}`}>{defaultIcon}</div>}
      <h3 className={`font-semibold text-white/90 ${currentSize.title}`}>{title}</h3>
      {description && <p className={`mt-1 text-white/60 max-w-md ${currentSize.description}`}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}