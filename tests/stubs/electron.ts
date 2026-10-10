// Testlerde gerçek `electron` paketi yüklenmez (vitest.config.ts alias'ı). Electron 44 binary'yi ilk require'da
// indirmeye çalıştığı için CI'da paralel test dosyaları birbirini bozuyordu; Node altında zaten API değil
// binary yolunu döndürür. Ana süreç modüllerinin testlerde dokunduğu tek API safeStorage'dır.

/** Şifreleme yok: kaydetme SecretStore'un kendi hatasıyla reddedilir, okuma null döner. */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): Buffer => {
    throw new Error('safeStorage testlerde kullanılamaz')
  },
  decryptString: (): string => {
    throw new Error('safeStorage testlerde kullanılamaz')
  }
}
