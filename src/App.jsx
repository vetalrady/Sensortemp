import React, { useState, useEffect, useCallback } from 'react';
import { 
  Thermometer, 
  Droplets, 
  Battery, 
  Clock, 
  RefreshCw, 
  LogOut, 
  AlertCircle, 
  Info, 
  Activity,
  WifiOff 
} from 'lucide-react';

// --- Helper Functions for Data Processing ---

// Averages a bucket of samples to smooth out the graph and reduce rendering load
const averageBucket = (bucket) => {
  let tempSum = 0, tempCount = 0;
  let humSum = 0, humCount = 0;
  
  bucket.forEach(s => {
    if (s.temperature != null) { tempSum += s.temperature; tempCount++; }
    if (s.humidity != null) { humSum += s.humidity; humCount++; }
  });

  // Use the time of the last observation in the bucket for the x-axis
  const lastObserved = bucket[bucket.length - 1].observed;

  return {
    observed: lastObserved,
    temperature: tempCount > 0 ? tempSum / tempCount : null,
    humidity: humCount > 0 ? humSum / humCount : null
  };
};

// Groups raw data into time-based buckets (e.g., 30 mins)
const downsampleHistory = (samples, intervalMinutes = 30) => {
  if (!samples || samples.length === 0) return [];
  
  const intervalMs = intervalMinutes * 60 * 1000;
  // SensorPush returns newest first. Sort oldest to newest for linear bucketing.
  const sorted = [...samples].sort((a, b) => new Date(a.observed).getTime() - new Date(b.observed).getTime());
  
  const bucketed = [];
  let bucketStart = new Date(sorted[0].observed).getTime();
  let bucket = [];

  sorted.forEach(sample => {
    const time = new Date(sample.observed).getTime();
    if (time - bucketStart >= intervalMs) {
      if (bucket.length > 0) bucketed.push(averageBucket(bucket));
      bucketStart = time;
      bucket = [sample];
    } else {
      bucket.push(sample);
    }
  });
  
  // Push the final remaining bucket
  if (bucket.length > 0) bucketed.push(averageBucket(bucket));
  
  return bucketed;
};

export default function App() {
  // Authentication & State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [useProxy, setUseProxy] = useState(true);
  
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Data & Settings State
  const [sensors, setSensors] = useState([]);
  const [unit, setUnit] = useState('F'); // 'F' or 'C'

  useEffect(() => {
    const savedToken = sessionStorage.getItem('sp_token');
    const savedEmail = sessionStorage.getItem('sp_email');
    if (savedToken) {
      setAccessToken(savedToken);
      if (savedEmail) setEmail(savedEmail);
    }
  }, []);

  const spFetch = async (endpoint, payload, token) => {
    const targetUrl = `https://api.sensorpush.com/api/v1${endpoint}`;
    const url = useProxy ? `https://corsproxy.io/?${encodeURIComponent(targetUrl)}` : targetUrl;
    
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    if (token) headers['Authorization'] = token;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {})
    });

    if (!res.ok) {
      let msg = `HTTP Error ${res.status}`;
      try {
        const errObj = await res.json();
        msg = errObj.message || errObj.error || msg;
      } catch (e) {
        msg = (await res.text()) || msg;
      }
      throw new Error(msg);
    }
    return res.json();
  };

  const fetchData = useCallback(async (tokenToUse = accessToken) => {
    if (!tokenToUse) return;
    setLoading(true);
    setError('');
    
    try {
      const sensorsRes = await spFetch('/devices/sensors', {}, tokenToUse);
      
      // Fetch data from exactly 24 hours ago. 
      // Limit 2000 is a safety net (1440 mins in 24h) in case the API limits without it.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const samplesRes = await spFetch('/samples', { 
        startTime: twentyFourHoursAgo,
        limit: 2000 
      }, tokenToUse);
      
      const sensorsList = Object.keys(sensorsRes).map(id => {
        const info = sensorsRes[id];
        const rawHistory = samplesRes.sensors?.[id] || [];
        
        // Save the absolute newest raw sample for the main display digits
        const latestSample = rawHistory[0] || null;
        
        // Downsample the history to ~30 min increments for the graph
        const processedHistory = downsampleHistory(rawHistory, 30);
        
        return {
          id,
          name: info.name || 'Unnamed Sensor',
          battery: info.battery_voltage,
          active: info.active,
          sample: latestSample,
          history: processedHistory
        };
      });
      
      sensorsList.sort((a, b) => a.name.localeCompare(b.name));
      setSensors(sensorsList);
      
    } catch (err) {
      console.error("Data Fetch Error:", err);
      setError(err.message || 'Failed to fetch sensor data.');
      if (err.message.includes('403') || err.message.includes('401')) {
         handleLogout(); 
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, useProxy]);

  useEffect(() => {
    if (accessToken && sensors.length === 0) {
      fetchData(accessToken);
    }
  }, [accessToken, fetchData, sensors.length]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const authRes = await spFetch('/oauth/authorize', { email, password });
      if (!authRes.authorization) throw new Error('No authorization code returned');
      
      const tokenRes = await spFetch('/oauth/accesstoken', { authorization: authRes.authorization });
      if (!tokenRes.accesstoken) throw new Error('No access token returned');
      
      const token = tokenRes.accesstoken;
      setAccessToken(token);
      sessionStorage.setItem('sp_token', token);
      sessionStorage.setItem('sp_email', email);
      
      await fetchData(token);
    } catch (err) {
      console.error("Login Error:", err);
      setError(err.message || 'Login failed. Please check your credentials.');
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setAccessToken('');
    setSensors([]);
    setPassword('');
    sessionStorage.removeItem('sp_token');
    sessionStorage.removeItem('sp_email');
  };

  // --- Views ---

  if (!accessToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 p-4 font-sans text-gray-100">
        <div className="bg-gray-900 rounded-2xl shadow-2xl shadow-black/50 p-8 max-w-md w-full border border-gray-800">
          <div className="flex justify-center mb-6">
            <div className="bg-blue-600 p-4 rounded-2xl shadow-lg shadow-blue-900/50">
              <Activity className="w-8 h-8 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center mb-2">SensorPush Portal</h1>
          <p className="text-center text-gray-400 mb-8 text-sm">Sign in to monitor your environmental data</p>
          
          {error && (
            <div className="bg-red-900/30 text-red-400 p-3 rounded-xl mb-6 flex items-center text-sm font-medium border border-red-900/50">
              <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-1.5">Email Address</label>
              <input 
                type="email" 
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-gray-950 border border-gray-800 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-white placeholder-gray-600"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-1.5">Password</label>
              <input 
                type="password" 
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-950 border border-gray-800 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-white placeholder-gray-600"
                placeholder="••••••••"
                required
              />
            </div>
            
            <div className="flex items-start bg-gray-950/50 p-3 rounded-xl border border-gray-800">
              <input 
                type="checkbox" 
                id="proxy" 
                checked={useProxy} 
                onChange={e => setUseProxy(e.target.checked)}
                className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 bg-gray-900 border-gray-700 rounded cursor-pointer"
              />
              <label htmlFor="proxy" className="ml-3 block text-xs text-gray-400 cursor-pointer">
                <strong className="text-gray-300">Use CORS Proxy</strong><br/>
                Required when running in a web browser to prevent the API requests from being blocked.
              </label>
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-4 rounded-xl transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed shadow-md shadow-blue-900/20"
            >
              {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : 'Connect to SensorPush'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 font-sans text-gray-100 pb-12">
      <header className="bg-gray-900 shadow-md border-b border-gray-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center">
            <div className="bg-blue-500/20 p-1.5 rounded-lg mr-3 border border-blue-500/30">
              <Activity className="w-5 h-5 text-blue-400" />
            </div>
            <h1 className="text-xl font-bold hidden sm:block text-white">My Sensors</h1>
          </div>
          
          <div className="flex items-center space-x-3 sm:space-x-5">
            <div className="flex bg-gray-950 rounded-lg p-1 border border-gray-800">
              <button 
                onClick={() => setUnit('F')}
                className={`px-3 py-1 rounded-md text-sm font-semibold transition-all ${unit === 'F' ? 'bg-gray-800 text-blue-400 shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                °F
              </button>
              <button 
                onClick={() => setUnit('C')}
                className={`px-3 py-1 rounded-md text-sm font-semibold transition-all ${unit === 'C' ? 'bg-gray-800 text-blue-400 shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
              >
                °C
              </button>
            </div>
          
            <button 
              onClick={() => fetchData()} 
              disabled={loading}
              className="p-2 text-gray-400 hover:bg-gray-800 hover:text-blue-400 rounded-full transition-colors"
              title="Refresh Data"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin text-blue-400' : ''}`} />
            </button>

            <button 
              onClick={handleLogout}
              className="flex items-center text-sm font-semibold text-red-400 hover:bg-red-500/10 px-3 py-2 rounded-lg transition-colors border border-transparent hover:border-red-500/20"
            >
              <LogOut className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">Dashboard Overview</h2>
          <span className="text-sm font-medium text-gray-400 bg-gray-900 px-3 py-1 rounded-full border border-gray-800">
            {sensors.length} {sensors.length === 1 ? 'Sensor' : 'Sensors'}
          </span>
        </div>

        {error && (
          <div className="bg-red-900/20 text-red-400 p-4 rounded-xl mb-6 flex items-center border border-red-900/50 shadow-sm">
            <AlertCircle className="w-5 h-5 mr-3 flex-shrink-0" />
            <p className="font-medium">{error}</p>
          </div>
        )}

        {sensors.length === 0 && !loading && !error && (
          <div className="text-center py-16 bg-gray-900 rounded-2xl shadow-sm border border-gray-800">
            <div className="bg-gray-950 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 border border-gray-800">
              <Info className="w-10 h-10 text-gray-600" />
            </div>
            <h3 className="text-xl font-semibold text-gray-200 mb-2">No Sensors Found</h3>
            <p className="text-gray-500 max-w-sm mx-auto">We couldn't find any sensors linked to this account. Ensure your gateways are online or your app has synced recently.</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {sensors.map(sensor => (
            <SensorCard key={sensor.id} sensor={sensor} unit={unit} />
          ))}
        </div>
      </main>
    </div>
  );
}

const Sparkline = ({ data, color }) => {
  if (!data || data.length < 2) return <div className="h-12 w-full mt-2" />;
  
  const minX = Math.min(...data.map(d => d.x));
  const maxX = Math.max(...data.map(d => d.x));
  const minY = Math.min(...data.map(d => d.y));
  const maxY = Math.max(...data.map(d => d.y));

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const paddingY = rangeY * 0.15;
  const adjustedMinY = minY - paddingY;
  const adjustedMaxY = maxY + paddingY;
  const adjustedRangeY = adjustedMaxY - adjustedMinY || 1;

  const pathData = data.map((d, i) => {
    const x = ((d.x - minX) / rangeX) * 100;
    const y = 100 - (((d.y - adjustedMinY) / adjustedRangeY) * 100);
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  const areaData = `${pathData} L 100 100 L 0 100 Z`;

  const theme = {
    orange: { stroke: 'stroke-orange-500', fill: 'fill-orange-500/20' },
    blue: { stroke: 'stroke-blue-500', fill: 'fill-blue-500/20' }
  };

  return (
    <div className="h-14 w-full mt-2 overflow-hidden relative group">
      <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="none">
        <path 
          d={areaData} 
          className={`${theme[color].fill} stroke-none`} 
          vectorEffect="non-scaling-stroke"
        />
        <path 
          d={pathData} 
          className={`${theme[color].stroke} fill-none`} 
          strokeWidth="2.5" 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
};

const SensorCard = ({ sensor, unit }) => {
  const { name, battery, active, sample, history } = sensor;
  
  const formatTemp = (tempF) => {
    if (tempF === undefined || tempF === null) return '--';
    if (unit === 'C') return ((tempF - 32) * 5 / 9).toFixed(1) + '°';
    return tempF.toFixed(1) + '°';
  };

  const formatHumidity = (hum) => {
    if (hum === undefined || hum === null) return '--';
    return hum.toFixed(1) + '%';
  };

  const formatTime = (isoString) => {
    if (!isoString) return 'Never';
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  };
  
  // Create X/Y coordinate arrays for the sparklines
  const tempGraphData = history
    .filter(h => h.temperature != null)
    .map(h => ({
      x: new Date(h.observed).getTime(),
      y: unit === 'C' ? ((h.temperature - 32) * 5/9) : h.temperature
    }));

  const humGraphData = history
    .filter(h => h.humidity != null)
    .map(h => ({
      x: new Date(h.observed).getTime(),
      y: h.humidity
    }));

  const getBatteryStatus = (volts) => {
    if (!volts) return { color: 'text-gray-500', level: 'Unknown', icon: Battery };
    if (volts >= 2.8) return { color: 'text-emerald-400', level: `${volts.toFixed(2)}V`, icon: Battery };
    if (volts >= 2.5) return { color: 'text-amber-400', level: `${volts.toFixed(2)}V`, icon: Battery };
    return { color: 'text-red-400', level: `${volts.toFixed(2)}V`, icon: Battery };
  };

  const battStatus = getBatteryStatus(battery);
  const BattIcon = battStatus.icon;
  const isStale = sample ? (Date.now() - new Date(sample.observed).getTime() > 1000 * 60 * 60 * 2) : true; 

  return (
    <div className={`bg-gray-900 rounded-2xl shadow-lg border ${!active ? 'border-red-900/50' : 'border-gray-800'} hover:border-gray-700 transition-all relative overflow-hidden flex flex-col h-full`}>
      {!active && (
        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
      )}
      
      <div className="p-5 flex-grow flex flex-col">
        <div className="flex justify-between items-start mb-5">
          <h3 className="font-bold text-lg text-white truncate pr-2 tracking-tight" title={name}>{name}</h3>
          {!active && <span className="text-[10px] font-bold uppercase tracking-wider bg-red-500/10 text-red-400 px-2.5 py-1 rounded-md border border-red-500/20">Offline</span>}
        </div>

        {sample ? (
          <div className="grid grid-cols-2 gap-4 mb-2 flex-grow">
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl pt-4 pb-0 flex flex-col justify-between overflow-hidden relative">
              <div className="px-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center text-orange-400">
                    <Thermometer className="w-4 h-4 mr-1.5" />
                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Temp</span>
                  </div>
                  <span className="text-[9px] font-semibold text-gray-500 bg-gray-900/50 px-1.5 rounded uppercase tracking-wider">24H</span>
                </div>
                <div className="text-3xl font-black text-white tracking-tighter">
                  {formatTemp(sample.temperature)}
                </div>
              </div>
              <Sparkline data={tempGraphData} color="orange" />
            </div>
            
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl pt-4 pb-0 flex flex-col justify-between overflow-hidden relative">
              <div className="px-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center text-blue-400">
                    <Droplets className="w-4 h-4 mr-1.5" />
                    <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Humidity</span>
                  </div>
                  <span className="text-[9px] font-semibold text-gray-500 bg-gray-900/50 px-1.5 rounded uppercase tracking-wider">24H</span>
                </div>
                <div className="text-3xl font-black text-white tracking-tighter">
                  {formatHumidity(sample.humidity)}
                </div>
              </div>
              <Sparkline data={humGraphData} color="blue" />
            </div>
          </div>
        ) : (
          <div className="py-12 flex flex-col items-center justify-center text-gray-500 bg-gray-950/50 rounded-xl mb-4 flex-grow border border-gray-800 border-dashed">
            <WifiOff className="w-8 h-8 mb-3 opacity-30" />
            <p className="text-sm font-medium">No recent readings</p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs font-medium text-gray-400 border-t border-gray-800 bg-gray-950/30 px-5 py-3 mt-auto">
        <div className="flex items-center bg-gray-900 px-2 py-1 rounded-md border border-gray-800" title="Battery Voltage">
          <BattIcon className={`w-3.5 h-3.5 mr-1.5 ${battStatus.color}`} />
          <span>{battStatus.level}</span>
        </div>
        <div className={`flex items-center bg-gray-900 px-2 py-1 rounded-md border border-gray-800 ${isStale && sample ? 'text-amber-400 border-amber-900/50 bg-amber-900/10' : ''}`} title="Last Reading Time">
          <Clock className="w-3.5 h-3.5 mr-1.5 opacity-70" />
          <span className="truncate max-w-[110px]">{formatTime(sample?.observed)}</span>
        </div>
      </div>
    </div>
  );
};


