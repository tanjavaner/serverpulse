import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { initLangFromUrl } from '../lib/api'
import { Widget } from './Widget'

initLangFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Widget />
  </StrictMode>
)
