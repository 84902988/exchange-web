interface LoadingSkeletonProps {
  className?: string;
  height?: string | number;
  width?: string | number;
  variant?: 'text' | 'rect' | 'circle';
}

export default function LoadingSkeleton({
  className = '',
  height,
  width,
  variant = 'rect',
}: LoadingSkeletonProps) {
  const baseStyles = 'animate-pulse rounded-md bg-white/10';
  const variantStyles = {
    text: 'h-4 w-3/4',
    rect: '',
    circle: 'rounded-full',
  };
  const sizeStyles = {
    height: height ? `height: ${typeof height === 'number' ? `${height}px` : height};` : '',
    width: width ? `width: ${typeof width === 'number' ? `${width}px` : width};` : '',
  };

  return (
    <div
      className={`${baseStyles} ${variantStyles[variant]} ${className}`}
      style={{
        ...(height && { height }),
        ...(width && { width }),
      }}
    />
  );
}

// 骨架屏容器组件，用于组合多个骨架屏
export function LoadingSkeletonContainer({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-4 ${className}`}>
      {children}
    </div>
  );
}