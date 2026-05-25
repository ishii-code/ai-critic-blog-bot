export function normalizeUrl(url: string, removeParams: string[] = []): string {
  try {
    const u = new URL(url)
    u.protocol = u.protocol.toLowerCase()
    u.hostname = u.hostname.toLowerCase()

    for (const param of removeParams) {
      u.searchParams.delete(param)
    }

    let result = u.toString()
    if (result.endsWith('/')) result = result.slice(0, -1)

    return result
  } catch {
    return url
  }
}
