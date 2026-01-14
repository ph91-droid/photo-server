import React, { useState, useEffect } from 'react';

function App() {
  const [userName, setUserName] = useState('');
  const [isStarted, setIsStarted] = useState(false);
  const [images, setImages] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null); // Lightbox用

  const [error, setError] = useState(null);

  useEffect(() => {
    if (isStarted) {
      setLoading(true);
      setError(null);
      const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';
      fetch(`${API_BASE}/api/images`)
        .then(res => {
          if (!res.ok) throw new Error('API Error');
          return res.json();
        })
        .then(data => {
          if (data.error) throw new Error(data.error);
          setImages(data);
          setLoading(false);
        })
        .catch(err => {
          console.error('Failed to fetch images:', err);
          setError('画像の読み込みに失敗しました。ページを再読み込みしてください。');
          setLoading(false);
        });
    }
  }, [isStarted]);

  const toggleSelect = (imageName) => {
    setSelected(prev =>
      prev.includes(imageName)
        ? prev.filter(name => name !== imageName)
        : [...prev, imageName]
    );
  };

  const handleSubmit = async () => {
    if (selected.length === 0) return;

    setSubmitting(true);
    try {
      const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';
      const response = await fetch(`${API_BASE}/api/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userName: userName,
          selectedImages: selected
        })
      });
      alert(`セレクトを送信しました！${userName}様、ありがとうございました。`);
      setSelected([]);
    } catch (err) {
      alert('送信に失敗しました。');
    } finally {
      setSubmitting(false);
    }
  };

  // エントリ画面（名前入力）
  if (!isStarted) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h1>PHOTO SELECT</h1>
          <p>お名前を入力してセレクトを開始してください。</p>
          <input
            type="text"
            placeholder="お名前"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
          <button
            className="submit-btn"
            onClick={() => userName && setIsStarted(true)}
            disabled={!userName}
          >
            開始する
          </button>
          <p className="login-notice">セレクト期間は30日間です。期間を過ぎると閲覧できなくなります。</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="app-container">高画質データを読み込んでいます...</div>;
  }

  if (error) {
    return (
      <div className="app-container">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <p style={{ color: 'red' }}>{error}</p>
          <button className="submit-btn" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header>
        <h1>{userName} 様</h1>
        <p>画像のセレクトをお楽しみください！</p>
        <div className="period-badge-container">
          <div className="period-badge">
            セレクト期間は30日間です。期間を過ぎると閲覧できなくなります。
          </div>
        </div>
      </header>

      <div className="gallery-grid">
        {images.map(img => {
          const isSelected = selected.includes(img.name);
          return (
            <div
              className={`image-card ${isSelected ? 'selected' : ''}`}
              key={img.name}
              onClick={() => setSelectedImage(img.url)}
            >
              <div className="image-wrapper">
                <img
                  src={img.url}
                  alt={img.name}
                  onContextMenu={(e) => e.preventDefault()}
                  style={{ pointerEvents: 'auto', userSelect: 'none' }}
                />
              </div>
              <div className="image-info">
                <span className="image-name">{img.name}</span>
                <button
                  className="select-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(img.name);
                  }}
                >
                  {isSelected ? '取消' : '選択'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="action-bar">
        <div className="selection-count">
          選択中: <span>{selected.length}</span> 枚
        </div>
        <button
          className="submit-btn"
          onClick={handleSubmit}
          disabled={selected.length === 0 || submitting}
        >
          {submitting ? '保存中...' : 'セレクトを送信する'}
        </button>
      </div>

      {/* Lightbox Modal */}
      {selectedImage && (
        <div className="modal-overlay" onClick={() => setSelectedImage(null)}>
          <div className="modal-content">
            <img
              src={selectedImage}
              alt="Enlarged"
              onContextMenu={(e) => e.preventDefault()}
            />
            <button className="modal-close" onClick={() => setSelectedImage(null)}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
