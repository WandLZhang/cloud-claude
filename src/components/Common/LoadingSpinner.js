import React from 'react';

function LoadingSpinner({ size = 'medium', color = 'primary' }) {
  const sizeClasses = {
    small: { width: '24px', height: '24px' },
    medium: { width: '40px', height: '40px' },
    large: { width: '60px', height: '60px' }
  };

  const colorVar = color === 'primary' ? 'var(--primary)' : color;

  return (
    <>
      <style>{`
        @keyframes spinner-appear {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes spinner-rotate {
          100% {
            transform: rotate(360deg);
          }
        }
        
        @keyframes spinner-dash {
          0% {
            stroke-dasharray: 1, 200;
            stroke-dashoffset: 0;
          }
          50% {
            stroke-dasharray: 90, 200;
            stroke-dashoffset: -35px;
          }
          100% {
            stroke-dasharray: 90, 200;
            stroke-dashoffset: -124px;
          }
        }
      `}</style>
      <div 
        className="loading-spinner"
        style={{
          display: 'inline-block',
          // Invisible for the first 400 ms: most loads finish sooner, and a spinner that shows for
          // a moment reads as a flash.
          animation: 'spinner-appear 0.2s ease-out 0.4s both',
          ...sizeClasses[size]
        }}
      >
        <svg
          viewBox="0 0 50 50"
          style={{
            animation: 'spinner-rotate 2s linear infinite',
            width: '100%',
            height: '100%'
          }}
        >
          <circle
            cx="25"
            cy="25"
            r="20"
            fill="none"
            stroke={colorVar}
            strokeWidth="4"
            strokeDasharray="1, 200"
            strokeDashoffset="0"
            strokeLinecap="round"
            style={{
              animation: 'spinner-dash 1.5s ease-in-out infinite'
            }}
          />
        </svg>
      </div>
    </>
  );
}

export default LoadingSpinner;
