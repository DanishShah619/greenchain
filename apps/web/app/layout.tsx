import './globals.css';
export const metadata={title:'GreenChain · Field workspace',description:'Synthetic GreenChain MVP demonstration',manifest:'/manifest.webmanifest',appleWebApp:{capable:true,title:'GreenChain',statusBarStyle:'default'},icons:{apple:'/icons/icon-192.png'}};
export const viewport={themeColor:'#153e30',width:'device-width',initialScale:1};
export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
