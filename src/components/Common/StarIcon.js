import React from 'react';

// The icon font (Google Symbols) draws only the outlined star unless it loads its fill axis, which
// adds 173 kB to every cold load. A starred chat gets this filled star instead.
function StarIcon({ filled, size = 20, className = '' }) {
  if (!filled) return <span className={`icon ${className}`.trim()}>star</span>;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}

export default StarIcon;
