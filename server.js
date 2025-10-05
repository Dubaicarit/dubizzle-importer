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
    await page.waitForTimeout(5000);
    await page.waitForTimeout(5000);

// DEBUG: Salva screenshot e HTML
await page.screenshot({ path: '/tmp/dubizzle-debug.png', fullPage: true });
const html = await page.content();
console.log('=== INIZIO HTML ===');
console.log(html.substring(0, 5000)); // Primi 5000 caratteri
console.log('=== FINE HTML ===');
    try {
      await page.waitForSelector('h6[data-testid="listing-sub-heading"], h1', { timeout: 15000 });
    } catch (e) {
      console.log('Selettore titolo non trovato, continuo comunque...');
    }
    
    const carData = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : '';
      };
      
      const title = getText('h6[data-testid="listing-sub-heading"]') || 
                    getText('h6.MuiTypography-h6') || 
                    getText('h1') || '';
      
      const priceText = getText('span.MuiTypography-h5') || '';
      const price = priceText.replace(/[^\d]/g, '');
      
      const titleParts = title.split(' ');
      const make = titleParts[0] || '';
      
      const yearMatch = title.match(/\d{4}/);
      const year = yearMatch ? yearMatch[0] : '';
      
      const model = titleParts.slice(1).join(' ').replace(/\d{4}/, '').trim() || '';
      
      const specs = {};
      
      document.querySelectorAll('div[class*="PropertyRow"], tr').forEach(row => {
        const cells = row.querySelectorAll('td, div, span');
        if (cells.length >= 2) {
          const key = cells[0].textContent.trim();
          const value = cells[1].textContent.trim();
          if (key && value && key.length < 50) {
            specs[key] = value;
          }
        }
      });
      
      document.querySelectorAll('li, div[class*="spec"], div[class*="detail"]').forEach(el => {
        const text = el.textContent.trim();
        if (text.includes(':')) {
          const parts = text.split(':');
          if (parts.length === 2) {
            const key = parts[0].trim();
            const value = parts[1].trim();
            if (key && value && key.length < 50) {
              specs[key] = value;
            }
          }
        }
      });
      
      return {
        title: title,
        price: price,
        year: year,
        make: make,
        model: model,
        mileage: specs['Kilometers'] || specs['Mileage'] || specs['Km'] || '',
        bodyType: specs['Body Type'] || specs['Body type'] || '',
        fuelType: specs['Fuel Type'] || specs['Fuel type'] || 'Petrol',
        transmission: specs['Transmission'] || specs['Gearbox'] || 'Automatic',
        exteriorColor: specs['Exterior Color'] || specs['Color'] || specs['Exterior color'] || '',
        interiorColor: specs['Interior Color'] || specs['Interior color'] || '',
        specs: specs
      };
    });
    
    const description = await page.evaluate(() => {
      const descEl = document.querySelector('[class*="description"], [data-testid*="description"]');
      return descEl ? descEl.textContent.trim() : '';
    });
    
    console.log('Estrazione immagini HD...');
    const imagesHD = await page.evaluate(() => {
      const images = new Set();
      const imgElements = document.querySelectorAll('img');
      
      imgElements.forEach(img => {
        let src = img.src || img.getAttribute('src') || img.dataset.src || '';
        
        if (src && src.includes('dbz-images.dubizzle.com')) {
          if (!src.includes('logo') && !src.includes('icon') && !src.includes('placeholder')) {
            const cleanUrl = src.split('?')[0];
            images.add(cleanUrl);
          }
        }
      });
      
      return Array.from(images);
    });
    
    console.log(`Trovate ${imagesHD.length} immagini`);
    
    const features = await page.evaluate(() => {
      const feats = new Set();
      
      const selectors = [
        '[class*="feature"]',
        '[class*="amenity"]',
        '[class*="option"]',
        'li[class*="MuiListItem"]',
        'div[class*="chip"]',
        '[data-testid*="feature"]'
      ];
      
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
          const text = el.textContent.trim();
          if (text && text.length > 2 && text.length < 100 && !text.includes('\n')) {
            feats.add(text);
          }
        });
      });
      
      return Array.from(feats);
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