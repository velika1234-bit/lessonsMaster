import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export const Card = ({
  children,
  className = '',
  style,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
} & HTMLAttributes<HTMLDivElement>) => (
  <div
    className={`bg-white rounded-3xl border border-gray-50 shadow-xl shadow-gray-100/50 p-8 ${className}`}
    style={style}
    {...rest}
  >
    {children}
  </div>
);
