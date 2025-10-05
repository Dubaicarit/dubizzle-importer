const express = require('express');
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY
});

async function scrapeDubizzle(url) {
  let browser;
  
  try {
   browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080'
  ]
});

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    console.log('Caricamento pagina:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Aspetta che la pagina carichi completamente
await page.waitForTimeout(5000);

// Prova diversi selettori
try {
  await page.waitForSelector('h1, [data-testid="title"], .listing-title', { timeout: 15000 });
} catch (e) {
  console.log('Selettore h1 non trovato, continuo comunque...');
}
    
    const carData = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : '';
      };
      
      const getPrice = () => {
        const priceEl = document.querySelector('[class*="price"]');
        if (priceEl) {
          const match = priceEl.textContent.match(/[\d,]+/);
          return match ? match[0].replace(/,/g, '') : '';
        }
        return '';
      };
      
      const title = getText('h1') || '';
      const titleParts = title.split(' ');
      
      const specs = {};
      document.querySelectorAll('[class*="spec"], [class*="detail"]').forEach(el => {
        const label = el.querySelector('[class*="label"]');
        const value = el.querySelector('[class*="value"]');
        if (label && value) {
          specs[label.textContent.trim()] = value.textContent.trim();
        }
      });
      
      return {
        title: title,
        price: getPrice(),
        year: specs['Year'] || titleParts[titleParts.length - 1] || '',
        make: titleParts[0] || '',
        model: titleParts.slice(1, -1).join(' ') || '',
        mileage: specs['Kilometers'] || specs['Mileage'] || '',
        bodyType: specs['Body Type'] || '',
        fuelType: specs['Fuel Type'] || '',
        transmission: specs['Transmission'] || '',
        exteriorColor: specs['Exterior Color'] || specs['Color'] || '',
        interiorColor: specs['Interior Color'] || '',
        specs: specs
      };
    });
    
    const description = await page.evaluate(() => {
      const descEl = document.querySelector('[class*="description"]');
      return descEl ? descEl.textContent.trim() : '';
    });
    
    console.log('Estrazione immagini HD...');
    const imagesHD = await page.evaluate(async () => {
      const images = [];
      const thumbnails = document.querySelectorAll('[class*="thumbnail"], [class*="gallery"] img, [class*="image-gallery"] img');
      
      const getHDUrl = (src) => {
        if (!src) return null;
        return src
          .replace(/\/thumbs?\//, '/images/')
          .replace(/\/(small|medium|thumb)\//, '/large/')
          .replace(/[?&](w|h|width|height)=\d+/g, '')
          .replace(/[?&]resize=[^&]+/g, '');
      };
      
      thumbnails.forEach(img => {
        const hdUrl = img.dataset.src || img.dataset.original || img.dataset.large || img.src;
        const cleanUrl = getHDUrl(hdUrl);
        if (cleanUrl && !images.includes(cleanUrl)) {
          images.push(cleanUrl);
        }
      });
      
      if (images.length === 0) {
        const allImages = document.querySelectorAll('img');
        allImages.forEach(img => {
          const src = img.src || img.dataset.src;
          if (src && src.includes('dubizzle') && !src.includes('logo') && !src.includes('icon')) {
            const cleanUrl = getHDUrl(src);
            if (cleanUrl && !images.includes(cleanUrl)) {
              images.push(cleanUrl);
            }
          }
        });
      }
      
      return images;
    });
    
    try {
      await page.click('[class*="thumbnail"]:first-child, [class*="gallery"] img:first-child');
      await page.waitForTimeout(2000);
      
      const galleryImages = await page.evaluate(() => {
        const imgs = [];
        document.querySelectorAll('[class*="gallery"] img, [class*="lightbox"] img, [class*="modal"] img').forEach(img => {
          const src = img.src || img.dataset.src || img.dataset.original;
          if (src && !imgs.includes(src)) {
            imgs.push(src);
          }
        });
        return imgs;
      });
      
      galleryImages.forEach(img => {
        if (!imagesHD.includes(img)) {
          imagesHD.push(img);
        }
      });
    } catch (e) {
      console.log('Galleria non disponibile, uso immagini estratte');
    }
    
    const features = await page.evaluate(() => {
      const feats = [];
      document.querySelectorAll('[class*="feature"], [class*="amenity"], [class*="option"]').forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2) {
          feats.push(text);
        }
      });
      return feats;
    });
    
    await browser.close();
    
    return {
      ...carData,
      description,
      images: imagesHD,
      features,
      url
    };
    
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}
async function enhanceWithAI(carData) {
  const prompt = `Sei un esperto copywriter specializzato in automotive di lusso. Genera contenuti professionali in ITALIANO per questo annuncio auto:

DATI AUTO:
- Marca: ${carData.make}
- Modello: ${carData.model}
- Anno: ${carData.year}
- Prezzo: AED ${carData.price}
- Chilometraggio: ${carData.mileage} km
- Trasmissione: ${carData.transmission}
- Colore esterno: ${carData.exteriorColor}
- Colore interno: ${carData.interiorColor}
- Tipo carburante: ${carData.fuelType}
- Optional: ${carData.features.join(', ')}
${carData.description ? '- Descrizione originale: ' + carData.description : ''}

GENERA (in formato JSON):
1. "title": Titolo accattivante e SEO-friendly (max 80 caratteri)
2. "description": Descrizione completa e professionale (200-300 parole) che includa:
   - Introduzione emozionale
   - Caratteristiche tecniche principali
   - Highlights degli optional
   - Condizioni e storia del veicolo
   - Call to action
3. "highlights": Array di 5-7 punti salienti (es: ["Solo un proprietario", "Service completo", "Condizioni perfette"])

Usa un tono professionale ma caldo. Enfatizza lusso, prestazioni e affidabilità.

Rispondi SOLO con JSON valido, senza markdown o altro testo.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    const content = message.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    throw new Error('Formato risposta AI non valido');
    
  } catch (error) {
    console.error('Errore AI:', error);
    return {
      title: `${carData.make} ${carData.model} ${carData.year}`,
      description: carData.description || 'Auto in ottime condizioni',
      highlights: ['Disponibile subito', 'Ottimo rapporto qualità-prezzo']
    };
  }
}

app.post('/api/scrape', async (req, res) => {
  try {
    const { url, useAI } = req.body;
    
    if (!url || !url.includes('dubizzle.com')) {
      return res.status(400).json({ error: 'URL Dubizzle non valido' });
    }
    
    console.log('Inizio scraping:', url);
    const carData = await scrapeDubizzle(url);
    
    let aiContent = null;
    if (useAI && ANTHROPIC_API_KEY) {
      console.log('Generazione contenuti AI...');
      aiContent = await enhanceWithAI(carData);
    }
    
    const csvData = {
      year: carData.year,
      make: carData.make,
      model: carData.model,
      bodyStyle: carData.bodyType || 'N/A',
      mileage: carData.mileage.replace(/[^\d]/g, ''),
      transmission: carData.transmission || 'Automatic',
      fuelEconomy: carData.fuelType || 'Petrol',
      condition: 'Used',
      location: 'Dubai',
      price: carData.price,
      drivetrain: carData.specs['Drivetrain'] || carData.specs['Drive Type'] || 'N/A',
      engine: carData.specs['Engine'] || carData.specs['Engine Size'] || 'N/A',
      exteriorColor: carData.exteriorColor,
      interiorColor: carData.interiorColor || 'N/A',
      mpg: carData.specs['Fuel Economy'] || 'N/A',
      stockNumber: `DUB-${Date.now()}`,
      vinNumber: carData.specs['VIN'] || 'N/A',
      vehicleOverview: aiContent ? aiContent.description : carData.description,
      multiOptions: carData.features.join(','),
      latitude: '25.2048',
      longitude: '55.2708',
      otherComments: aiContent ? aiContent.highlights.join(' | ') : '',
      videoUrl: '',
      cityMpg: '',
      highwayMpg: '',
      imagesUrl: carData.images.join('|'),
      aiTitle: aiContent ? aiContent.title : carData.title,
      aiDescription: aiContent ? aiContent.description : '',
      aiHighlights: aiContent ? aiContent.highlights.join(' | ') : ''
    };
    
    res.json({
      success: true,
      data: csvData,
      rawData: carData,
      aiEnhanced: !!aiContent,
      imagesCount: carData.images.length
    });
    
  } catch (error) {
    console.error('Errore scraping:', error);
    res.status(500).json({ 
      error: 'Errore durante lo scraping',
      message: error.message 
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    aiEnabled: !!ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 AI Enhancement: ${ANTHROPIC_API_KEY ? 'ENABLED' : 'DISABLED'}`);
});