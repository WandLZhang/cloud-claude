import React, { useState, useEffect, useRef } from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { CopyToClipboard } from 'react-copy-to-clipboard';
import { saveToGoogleDocs, initializeGoogleAPI, isGoogleAuthorized } from '../../services/googleDriveService';

function ExportMenu({ message, messageRef }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [googleAPIInitialized, setGoogleAPIInitialized] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    // Initialize Google API when component mounts
    initializeGoogleAPI()
      .then(() => setGoogleAPIInitialized(true))
      .catch(err => {
        console.warn('Google API initialization failed:', err.message);
        setGoogleAPIInitialized(false);
      });
  }, []);

  useEffect(() => {
    // Close menu when clicking outside
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [isOpen]);

  const handleMenuClick = (e) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const handleExportToPDF = async () => {
    setIsExporting(true);
    setExportStatus('Generating PDF...');
    
    try {
      if (messageRef && messageRef.current) {
        // Create a temporary container for cleaner PDF export
        const tempDiv = document.createElement('div');
        tempDiv.style.position = 'absolute';
        tempDiv.style.left = '-9999px';
        tempDiv.style.width = '800px';
        tempDiv.style.padding = '20px';
        tempDiv.style.backgroundColor = 'white';
        tempDiv.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        
        // Clone the message content
        const clonedContent = messageRef.current.cloneNode(true);
        
        // Remove any export menu buttons from the clone
        const exportButtons = clonedContent.querySelectorAll('.export-menu-wrapper');
        exportButtons.forEach(btn => btn.remove());
        
        tempDiv.appendChild(clonedContent);
        document.body.appendChild(tempDiv);
        
        // Generate canvas from the temporary div
        const canvas = await html2canvas(tempDiv, {
          scale: 2,
          logging: false,
          windowWidth: 800
        });
        
        // Remove temporary div
        document.body.removeChild(tempDiv);
        
        // Create PDF
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF({
          orientation: 'portrait',
          unit: 'pt',
          format: 'a4'
        });
        
        const imgWidth = 595.28; // A4 width in pts
        const pageHeight = 841.89; // A4 height in pts
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        let heightLeft = imgHeight;
        let position = 0;
        
        // Add image to PDF, handling multiple pages if needed
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
        
        while (heightLeft >= 0) {
          position = heightLeft - imgHeight;
          pdf.addPage();
          pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
          heightLeft -= pageHeight;
        }
        
        // Save the PDF
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        pdf.save(`claude-message-${timestamp}.pdf`);
        
        setExportStatus('PDF exported successfully!');
        setTimeout(() => setExportStatus(''), 3000);
      }
    } catch (error) {
      console.error('Error exporting to PDF:', error);
      setExportStatus('Failed to export PDF');
      setTimeout(() => setExportStatus(''), 3000);
    } finally {
      setIsExporting(false);
      setIsOpen(false);
    }
  };

  const handleSaveToGoogleDocs = async () => {
    if (!googleAPIInitialized) {
      setExportStatus('Google API not initialized');
      setTimeout(() => setExportStatus(''), 3000);
      return;
    }

    setIsExporting(true);
    setExportStatus('Saving to Google Docs...');
    
    try {
      const result = await saveToGoogleDocs(message.content);
      
      if (result.success) {
        setExportStatus('Saved to Google Docs!');
        // Open the document in a new tab
        window.open(result.webViewLink, '_blank');
        setTimeout(() => setExportStatus(''), 3000);
      }
    } catch (error) {
      console.error('Error saving to Google Docs:', error);
      setExportStatus('Failed to save to Google Docs');
      setTimeout(() => setExportStatus(''), 3000);
    } finally {
      setIsExporting(false);
      setIsOpen(false);
    }
  };

  const handleCopySuccess = () => {
    setExportStatus('Copied to clipboard!');
    setTimeout(() => setExportStatus(''), 3000);
    setIsOpen(false);
  };

  return (
    <div className="export-menu-wrapper" ref={menuRef}>
      <button
        className="icon-button small export-menu-button"
        onClick={handleMenuClick}
        title="Export options"
        disabled={isExporting}
      >
        <span className="icon">more_vert</span>
      </button>
      
      {isOpen && (
        <div className="export-menu-dropdown">
          <button
            className="menu-item"
            onClick={handleExportToPDF}
            disabled={isExporting}
          >
            <span className="icon">picture_as_pdf</span>
            <span>Export as PDF</span>
          </button>
          
          <button
            className="menu-item"
            onClick={handleSaveToGoogleDocs}
            disabled={isExporting || !googleAPIInitialized}
            title={!googleAPIInitialized ? 'Google API not configured' : ''}
          >
            <span className="icon">description</span>
            <span>Save to Google Docs</span>
            {!googleAPIInitialized && (
              <span style={{ fontSize: '0.75em', opacity: 0.7, marginLeft: 'auto' }}>
                (Not configured)
              </span>
            )}
          </button>
          
          <CopyToClipboard 
            text={message.content}
            onCopy={handleCopySuccess}
          >
            <button
              className="menu-item"
              disabled={isExporting}
            >
              <span className="icon">content_copy</span>
              <span>Copy to Clipboard</span>
            </button>
          </CopyToClipboard>
        </div>
      )}
      
      {exportStatus && (
        <div className="export-status">
          {exportStatus}
        </div>
      )}
    </div>
  );
}

export default ExportMenu;
