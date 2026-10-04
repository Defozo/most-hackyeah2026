import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string|null}> { state={error:null as string|null};static getDerivedStateFromError(error:Error){return{error:error.message};}render(){return this.state.error?<main className="expired"><h1>Nie udało się otworzyć widoku</h1><p>Nie potwierdzono żadnego nowego zapisu. Dane zapisane na urządzeniu pozostają w jego pamięci.</p><pre>{this.state.error}</pre><button className="button primary" onClick={()=>location.reload()}>Uruchom ponownie</button></main>:this.props.children;} }
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
