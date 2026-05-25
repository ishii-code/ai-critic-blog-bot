import fs from 'fs'
import path from 'path'

export function loadEnv(envPath?: string): void {
  const filePath = envPath ?? path.resolve(__dirname, '../.env')
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key) process.env[key] = val
    }
  } catch {
    // .env が存在しない場合はスキップ
  }
}
