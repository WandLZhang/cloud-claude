import React, { useState, useEffect } from 'react';
import {
  getSavedPrompts,
  createPrompt,
  deletePrompt,
  updatePromptLastUsed,
  subscribeToUserPrompts
} from '../../services/firebase';
import './SavedPrompts.css';

function SavedPrompts({ userId, onSelectPrompt }) {
  const [prompts, setPrompts] = useState([]);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [showAddPrompt, setShowAddPrompt] = useState(false);
  const [newPromptTitle, setNewPromptTitle] = useState('');
  const [newPromptContent, setNewPromptContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Subscribe to real-time updates
    const unsubscribe = subscribeToUserPrompts(userId, (updatedPrompts) => {
      setPrompts(updatedPrompts);
    });

    return () => unsubscribe();
  }, [userId]);

  const handleSelectPrompt = async (promptId) => {
    const prompt = prompts.find(p => p.id === promptId);
    if (prompt) {
      setSelectedPromptId(promptId);
      onSelectPrompt(prompt.content);
      // Update last used timestamp
      try {
        await updatePromptLastUsed(userId, promptId);
      } catch (err) {
        console.error('Error updating prompt last used:', err);
      }
    } else {
      setSelectedPromptId('');
      onSelectPrompt('');
    }
  };

  const handleAddPrompt = async (e) => {
    e.preventDefault();
    if (!newPromptTitle.trim() || !newPromptContent.trim()) return;

    setLoading(true);
    setError('');

    try {
      await createPrompt(userId, {
        title: newPromptTitle.trim(),
        content: newPromptContent.trim()
      });
      setNewPromptTitle('');
      setNewPromptContent('');
      setShowAddPrompt(false);
    } catch (err) {
      console.error('Error creating prompt:', err);
      setError('Failed to save prompt. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePrompt = async (promptId, e) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this prompt?')) {
      try {
        await deletePrompt(userId, promptId);
        if (selectedPromptId === promptId) {
          setSelectedPromptId('');
          onSelectPrompt('');
        }
      } catch (err) {
        console.error('Error deleting prompt:', err);
        setError('Failed to delete prompt. Please try again.');
      }
    }
  };

  const handleDropdownChange = (e) => {
    const value = e.target.value;
    if (value === 'add-new') {
      setShowAddPrompt(true);
      setSelectedPromptId('');
    } else {
      handleSelectPrompt(value);
    }
  };

  return (
    <div className="saved-prompts-container">
      <h3 className="saved-prompts-title">Saved Prompts</h3>
      <div className="saved-prompts-controls">
        <div className="prompt-selector-wrapper">
          <select
            className="prompt-selector"
            value={selectedPromptId}
            onChange={handleDropdownChange}
          >
            <option value="">Choose a saved prompt...</option>
            <option value="add-new">+ Add New Prompt</option>
            {prompts.length > 0 && <option disabled>──────────</option>}
            {prompts.map(prompt => (
              <option key={prompt.id} value={prompt.id}>
                {prompt.title}
              </option>
            ))}
          </select>
          <span className="icon prompt-selector-icon">expand_more</span>
        </div>
      </div>

      {error && (
        <div className="prompt-error">
          <span className="icon">error</span>
          <span>{error}</span>
        </div>
      )}

      {showAddPrompt && (
        <div className="add-prompt-modal-overlay" onClick={() => setShowAddPrompt(false)}>
          <div className="add-prompt-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add New Prompt</h3>
            <form onSubmit={handleAddPrompt}>
              <div className="form-field">
                <label htmlFor="prompt-title">Title</label>
                <input
                  id="prompt-title"
                  type="text"
                  value={newPromptTitle}
                  onChange={(e) => setNewPromptTitle(e.target.value)}
                  placeholder="e.g., Code Review"
                  maxLength={50}
                  required
                  autoFocus
                />
              </div>
              
              <div className="form-field">
                <label htmlFor="prompt-content">Prompt</label>
                <textarea
                  id="prompt-content"
                  value={newPromptContent}
                  onChange={(e) => setNewPromptContent(e.target.value)}
                  placeholder="e.g., Please review this code for best practices..."
                  rows={4}
                  required
                />
              </div>
              
              <div className="modal-actions">
                <button
                  type="button"
                  className="cancel-button"
                  onClick={() => setShowAddPrompt(false)}
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="save-button"
                  disabled={loading || !newPromptTitle.trim() || !newPromptContent.trim()}
                >
                  {loading ? 'Saving...' : 'Save Prompt'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedPromptId && prompts.length > 0 && (
        <div className="selected-prompt-actions">
          <button
            className="delete-prompt-button"
            onClick={(e) => handleDeletePrompt(selectedPromptId, e)}
            aria-label="Delete selected prompt"
          >
            <span className="icon">delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default SavedPrompts;
