'use client';

interface AccountButtonProps {
  label: string;
  icon?: React.ReactNode;
  isActive?: boolean;
  onClick?: () => void;
}

export default function AccountButton({ label, icon, isActive = false, onClick }: AccountButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg p-3 transition-all duration-300 flex items-center gap-2 ${isActive
        ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-lg'
        : 'bg-[#1a1f2e] text-white/50 border border-white/10 hover:bg-white/10'}`}
    >
      {icon && <span>{icon}</span>}
      <span>{label}</span>
    </button>
  );
}