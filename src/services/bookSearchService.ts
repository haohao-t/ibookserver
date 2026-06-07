import axios from 'axios';

const hasCyrillic = (s: string) => /[а-яёА-ЯЁ]/.test(s);

export interface BookSearchResult {
  id: string;
  title: string;
  authors: string[];
  cover_url: string | null;
  pageCount: number | null;
  description: string | null;
  publishedYear: number | null;
  publisher: string | null;
  genre: string | null;
  source: 'google' | 'openlibrary' | 'yandex';
}

async function searchGoogleBooks(q: string): Promise<BookSearchResult[]> {
  const lang = hasCyrillic(q) ? '&langRestrict=ru&hl=ru' : '';
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : '';
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&printType=books${lang}${apiKey}`;
  try {
    const res = await axios.get(url, { timeout: 5000 });
    return (res.data.items || []).map((item: any) => ({
      id: `g_${item.id}`,
      title: item.volumeInfo?.title || '',
      authors: item.volumeInfo?.authors || [],
      cover_url: item.volumeInfo?.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
      pageCount: item.volumeInfo?.pageCount || null,
      description: item.volumeInfo?.description || null,
      publishedYear: item.volumeInfo?.publishedDate ? parseInt(item.volumeInfo.publishedDate) : null,
      publisher: item.volumeInfo?.publisher || null,
      genre: item.volumeInfo?.categories?.[0] || null,
      source: 'google' as const,
    }));
  } catch {
    return [];
  }
}

async function searchOpenLibrary(q: string): Promise<BookSearchResult[]> {
  const langFilter = hasCyrillic(q) ? ' language:rus' : '';
  const fields = 'key,title,author_name,cover_i,number_of_pages_median,subject,first_publish_year,publisher';
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q + langFilter)}&limit=10&fields=${fields}`;
  try {
    const res = await axios.get(url, { timeout: 5000 });
    return (res.data.docs || [])
      .filter((doc: any) => doc.title)
      .map((doc: any) => ({
        id: `ol_${doc.key}`,
        title: doc.title || '',
        authors: doc.author_name || [],
        cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
        pageCount: doc.number_of_pages_median || null,
        description: null,
        publishedYear: doc.first_publish_year || null,
        publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : (doc.publisher || null),
        genre: Array.isArray(doc.subject) ? doc.subject[0] : null,
        source: 'openlibrary' as const,
      }));
  } catch {
    return [];
  }
}

async function getCoverFromGoogle(title: string, author: string): Promise<{ cover_url: string | null; pageCount: number | null; publisher: string | null }> {
  try {
    const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : '';
    const res = await axios.get(
      `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&langRestrict=ru${apiKey}`,
      { timeout: 4000 }
    );
    const item = res.data.items?.[0];
    return {
      cover_url: item?.volumeInfo?.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
      pageCount: item?.volumeInfo?.pageCount || null,
      publisher: item?.volumeInfo?.publisher || null,
    };
  } catch {
    return { cover_url: null, pageCount: null, publisher: null };
  }
}

async function searchViaYandexGPT(query: string): Promise<BookSearchResult[]> {
  const folderId = process.env.YANDEX_FOLDER_ID;
  const apiKey = process.env.YANDEX_API_KEY;
  if (!folderId || !apiKey) return [];

  let gptBooks: any[] = [];

  try {
    const response = await axios.post(
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      {
        modelUri: `gpt://${folderId}/yandexgpt-lite`,
        completionOptions: { temperature: 0.1, maxTokens: 3000, stream: false },
        messages: [{
          role: 'user',
          text: `Найди книги по запросу пользователя: "${query}".
Верни JSON-массив из 8 наиболее подходящих реально существующих книг. Формат строго:
[{"title":"название на русском","author":"имя автора на русском","year":2020,"description":"2-3 предложения описания на русском"}]
Только JSON-массив, без пояснений.`,
        }],
      },
      {
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          'x-folder-id': folderId,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );

    const text: string = response.data.result?.alternatives?.[0]?.message?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) gptBooks = JSON.parse(match[0]);
  } catch (err) {
    console.error('[bookSearch] YandexGPT error:', err);
    return [];
  }

  const enriched = await Promise.all(
    gptBooks.map(async (book: any, i: number) => {
      const extra = await getCoverFromGoogle(book.title, book.author);
      return {
        id: `y_${i}_${(book.title || '').slice(0, 8).replace(/\s/g, '')}`,
        title: book.title || '',
        authors: book.author ? [book.author] : [],
        cover_url: extra.cover_url,
        pageCount: extra.pageCount,
        description: book.description || null,
        publishedYear: book.year || null,
        publisher: extra.publisher,
        genre: null,
        source: 'yandex' as const,
      } as BookSearchResult;
    })
  );

  return enriched;
}

function dedupe(items: BookSearchResult[]): BookSearchResult[] {
  const seen = new Set<string>();
  return items.filter(r => {
    const key = `${r.title.toLowerCase().trim()}|${(r.authors[0] || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const isCyrillic = hasCyrillic(query);

  const [googleResults, olResults, yandexResults] = await Promise.all([
    searchGoogleBooks(query),
    searchOpenLibrary(query),
    isCyrillic ? searchViaYandexGPT(query) : Promise.resolve([] as BookSearchResult[]),
  ]);

  return dedupe([...yandexResults, ...googleResults, ...olResults]);
}
