/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'] },
      colors: { card: '#1C1C1E', success: '#30D158', petrol: '#14B8A6', secondary: '#98989E' },
      borderRadius: { '2xl': '16px', '3xl': '24px' },
    },
  },
}
