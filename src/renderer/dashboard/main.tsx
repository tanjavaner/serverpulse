import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { initLangFromUrl } from '../lib/api'
import { App } from './App'

initLangFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
