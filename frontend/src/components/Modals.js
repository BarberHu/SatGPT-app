import React from 'react';
import { useUiContext } from '../context/AppContext';
import {
  helpDocuments,
  helpIntro,
  helpOverviewImage,
  helpSections,
} from '../content/helpContent';

function Modals() {
  const { activeModal, setActiveModal } = useUiContext();

  return (
    <>
      <WelcomeModal 
        isOpen={activeModal === 'welcome'} 
        onClose={() => setActiveModal(null)} 
      />
      <PromptModal 
        isOpen={activeModal === 'prompt'} 
        onClose={() => setActiveModal(null)} 
      />
      <Modal3D 
        isOpen={activeModal === '3d'} 
        onClose={() => setActiveModal(null)} 
      />
      <ErrorModal 
        isOpen={activeModal === 'error'} 
        onClose={() => setActiveModal(null)} 
      />
      <ContactModal 
        isOpen={activeModal === 'contact'} 
        onClose={() => setActiveModal(null)} 
      />
      <HelpModal 
        isOpen={activeModal === 'help'} 
        onClose={() => setActiveModal(null)} 
      />
    </>
  );
}

function WelcomeModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal" style={{ display: 'block', background: '#000000ad' }}>
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Welcome to SATGPT</h5>
          </div>
          <div className="modal-body">
            <p>
              This current version of SatGPT is a proof of concept on the integration 
              of Earth observation data, large language models, and generative AI. 
              We are actively developing the next version based on user feedback and 
              use cases from partner countries and is expected to be tested and 
              released in Q1 2026.
            </p>
            <button onClick={onClose} className="info-modal-btn">OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PromptModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal" style={{ display: 'block' }}>
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Select Grid for Flood Data Visualization</h5>
          </div>
          <div className="modal-body">
            <p>
              Please select a grid on the map to view the Flood data from 
              Google Earth Engine (GEE).
            </p>
            <button onClick={onClose} className="info-modal-btn">OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Modal3D({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal_3d" style={{ display: 'block' }}>
      <div className="modal-content_3d">
        <span className="close_3d" onClick={onClose}>&times;</span>
        <h4>Switch to 3D view</h4>
        <p>Click and drag while holding CTRL to explore the 3D view.</p>
      </div>
    </div>
  );
}

function ErrorModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal_3d" style={{ display: 'block' }}>
      <div className="modal-content_3d">
        <span className="close_3d" onClick={onClose}>&times;</span>
        <h4>No data Available</h4>
        <hr />
        <p>Please change the year or location.</p>
      </div>
    </div>
  );
}

function ContactModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal_3d" style={{ display: 'flex' }}>
      <div className="modal-content_3d">
        <span className="close_3d" onClick={onClose}>&times;</span>
        <h4>Contact Us</h4>
        <hr />
        <div className="contact-us-details">
          <p>Space Applications Section (SAS)</p>
          <p>Information and Communications Technology and Disaster Risk Reduction Division (IDD)</p>
          <p>United Nations Economic and Social Commission for Asia and the Pacific</p>
          <p style={{ display: 'flex', alignItems: 'center' }}>
            <i className="fa fa-envelope-o" style={{ fontSize: '20px', marginRight: '10px' }}></i>
            <a href="mailto:escap-sas@un.org">escap-sas@un.org</a>
          </p>
          <p style={{ display: 'flex', alignItems: 'center' }}>
            <i className="fa fa-envelope-o" style={{ fontSize: '20px', marginRight: '10px' }}></i>
            <a href="mailto:hamid.mehmood@un.org">hamid.mehmood@un.org</a>
          </p>
        </div>
      </div>
    </div>
  );
}

function HelpModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal_3d_help" style={{ display: 'flex' }}>
      <div className="modal-content_3d_help">
        <span className="close_3d" onClick={onClose}>&times;</span>
        <hr />
        <div className="help-details">
          <h2>SatGPT User Guide</h2>
          <div className="help-download-row">
            {helpDocuments.map((document) => (
              <a
                key={document.href}
                href={document.href}
                download
                className="help-download-btn"
              >
                {document.label}
              </a>
            ))}
          </div>

          <div className="help-intro">
            {helpIntro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>

          <section className="help-section">
            <h3>Interface Overview</h3>
            <div className="help-figure">
              <img src={helpOverviewImage} alt="SATGPT interface overview" />
            </div>
          </section>

          {helpSections.map((section) => (
            <section key={section.title} className="help-section">
              <h3>{section.title}</h3>
              <ol className="help-step-list">
                {section.steps.map((step) => (
                  <li key={`${section.title}-${step.text}`}>
                    <p>{step.text}</p>
                    {step.note ? <p className="help-note">{step.note}</p> : null}
                    {step.image ? (
                      <div className="help-figure">
                        <img src={step.image} alt={step.text} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Modals;
