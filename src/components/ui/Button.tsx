import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

interface ButtonProps {
  children: ReactNode;
  onClick?: (...args: any[]) => any;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  size?: string;
  title?: string;
  [key: string]: any;
}

export const Button = ({
  children,
  onClick,
  variant = 'primary',
  className = '',
  disabled = false,
  loading = false,
  size,
  title,
  ...rest
}: ButtonProps) => {
  const base = 'px-6 py-3 rounded-2xl font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 shadow-sm';
  const variants: Record<string, string> = {
    primary: 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-100',
    secondary: 'bg-white text-indigo-600 border-2 border-indigo-50 hover:bg-indigo-50',
    danger: 'bg-rose-50 text-rose-600 hover:bg-rose-100 border-2 border-rose-100',
    ghost: 'text-gray-400 hover:bg-gray-50 hover:text-gray-600 rounded-xl'
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${size || ''} ${className}`}
      title={title}
      {...rest}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : children}
    </button>
  );
};
