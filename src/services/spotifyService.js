const axios = require('axios');
const qs = require('qs');

let accessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const currentTime = Date.now();
  if (accessToken && currentTime < tokenExpiresAt) {
    return accessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ Spotify credentials missing in .env');
    return null;
  }

  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      qs.stringify({ grant_type: 'client_credentials' }),
      {
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    accessToken = response.data.access_token;
    // Token usually expires in 3600 seconds. We refresh it 1 minute before.
    tokenExpiresAt = currentTime + (response.data.expires_in - 60) * 1000;
    
    console.log('✅ New Spotify Access Token acquired');
    return accessToken;
  } catch (error) {
    console.error('❌ Error getting Spotify access token:', error.response?.data || error.message);
    return null;
  }
}

async function searchTracks(query) {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const response = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q: query,
        type: 'track',
        limit: 10,
        market: 'BR' // Targeted results for Brazil
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const items = response.data.tracks.items;
    return items.map(track => ({
      id: track.id,
      nome: track.name,
      artista: track.artists.map(a => a.name).join(', '),
      capa: track.album.images[0]?.url || 'https://placehold.co/200x200/121212/orange?text=?',
      duracao: msToMinutesAndSeconds(track.duration_ms),
      duration_ms: track.duration_ms
    }));
  } catch (error) {
    console.error('❌ Spotify Search Error:', error.response?.data || error.message);
    return [];
  }
}

function msToMinutesAndSeconds(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return minutes + ":" + (seconds < 10 ? '0' : '') + seconds;
}

module.exports = {
  searchTracks
};
