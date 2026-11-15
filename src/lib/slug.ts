export function slugify(texto: string, max = 40): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter(Boolean)
    .join('-')
    .slice(0, max);
}
