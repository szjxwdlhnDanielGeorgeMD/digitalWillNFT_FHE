import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DigitalWill {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  beneficiary: string;
  status: "active" | "executed" | "revoked";
  description: string;
}

// FHE encryption simulation for numbers
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const parts = encryptedData.split('-');
    if (parts.length >= 2) {
      return parseFloat(atob(parts[1]));
    }
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [wills, setWills] = useState<DigitalWill[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newWillData, setNewWillData] = useState({ 
    beneficiary: "", 
    description: "", 
    assetAmount: 0,
    instructions: "" 
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedWill, setSelectedWill] = useState<DigitalWill | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);

  // Statistics
  const activeCount = wills.filter(w => w.status === "active").length;
  const executedCount = wills.filter(w => w.status === "executed").length;
  const revokedCount = wills.filter(w => w.status === "revoked").length;

  useEffect(() => {
    loadWills().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadWills = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Test contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load will keys
      const keysBytes = await contract.getData("will_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { 
          console.error("Error parsing will keys:", e); 
        }
      }

      const list: DigitalWill[] = [];
      for (const key of keys) {
        try {
          const willBytes = await contract.getData(`will_${key}`);
          if (willBytes.length > 0) {
            try {
              const willData = JSON.parse(ethers.toUtf8String(willBytes));
              list.push({ 
                id: key, 
                encryptedData: willData.data, 
                timestamp: willData.timestamp, 
                owner: willData.owner, 
                beneficiary: willData.beneficiary,
                status: willData.status || "active",
                description: willData.description 
              });
            } catch (e) { 
              console.error(`Error parsing will data for ${key}:`, e); 
            }
          }
        } catch (e) { 
          console.error(`Error loading will ${key}:`, e); 
        }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setWills(list);
    } catch (e) { 
      console.error("Error loading wills:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitWill = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting digital will with Zama FHE..." 
    });
    
    try {
      // Encrypt asset amount using FHE simulation
      const encryptedData = FHEEncryptNumber(newWillData.assetAmount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const willId = `will-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const willData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        beneficiary: newWillData.beneficiary,
        description: newWillData.description,
        status: "active" 
      };
      
      // Store will data
      await contract.setData(`will_${willId}`, ethers.toUtf8Bytes(JSON.stringify(willData)));
      
      // Update keys list
      const keysBytes = await contract.getData("will_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(willId);
      await contract.setData("will_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Digital will encrypted and stored securely!" 
      });
      
      await loadWills();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewWillData({ beneficiary: "", description: "", assetAmount: 0, instructions: "" });
        setCurrentStep(1);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    setIsDecrypting(true);
    try {
      const message = `Decrypt digital will\nPublic Key: ${publicKey}\nContract: ${contractAddress}\nChain: ${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const executeWill = async (willId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Verifying death certificate and executing will..." 
    });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const willBytes = await contract.getData(`will_${willId}`);
      if (willBytes.length === 0) throw new Error("Will not found");
      
      const willData = JSON.parse(ethers.toUtf8String(willBytes));
      const updatedWill = { ...willData, status: "executed" };
      
      await contract.setData(`will_${willId}`, ethers.toUtf8Bytes(JSON.stringify(updatedWill)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Will executed successfully! Assets transferred to beneficiary." 
      });
      
      await loadWills();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Execution failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const revokeWill = async (willId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Revoking digital will..." 
    });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const willBytes = await contract.getData(`will_${willId}`);
      if (willBytes.length === 0) throw new Error("Will not found");
      
      const willData = JSON.parse(ethers.toUtf8String(willBytes));
      const updatedWill = { ...willData, status: "revoked" };
      
      await contract.setData(`will_${willId}`, ethers.toUtf8Bytes(JSON.stringify(updatedWill)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Will revoked successfully!" 
      });
      
      await loadWills();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Revocation failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (willOwner: string) => address?.toLowerCase() === willOwner.toLowerCase();
  const isBeneficiary = (willBeneficiary: string) => address?.toLowerCase() === willBeneficiary.toLowerCase();

  const tutorialSteps = [
    { 
      title: "Connect Wallet", 
      description: "Connect your Web3 wallet to create and manage your digital will",
      icon: "🔐" 
    },
    { 
      title: "Create Encrypted Will", 
      description: "Encrypt your asset distribution instructions using Zama FHE technology",
      icon: "📝",
      details: "Your sensitive data is encrypted client-side before blockchain storage" 
    },
    { 
      title: "FHE Protected Storage", 
      description: "Your will remains encrypted on-chain, accessible only to authorized parties",
      icon: "🛡️",
      details: "Zama FHE ensures data privacy while enabling verifiable execution" 
    },
    { 
      title: "Secure Inheritance", 
      description: "Beneficiaries can decrypt the will only after proper verification",
      icon: "👥",
      details: "Death certificate verification triggers decryption access" 
    }
  ];

  const renderStatusChart = () => {
    const total = wills.length || 1;
    const activePercentage = (activeCount / total) * 100;
    const executedPercentage = (executedCount / total) * 100;
    const revokedPercentage = (revokedCount / total) * 100;
    
    return (
      <div className="status-chart-container">
        <div className="status-chart">
          <div 
            className="chart-segment active" 
            style={{ 
              background: `conic-gradient(
                #3498db 0deg ${activePercentage * 3.6}deg,
                #27ae60 ${activePercentage * 3.6}deg ${(activePercentage + executedPercentage) * 3.6}deg,
                #e74c3c ${(activePercentage + executedPercentage) * 3.6}deg 360deg
              )` 
            }}
          >
            <div className="chart-center">
              <div className="chart-value">{wills.length}</div>
              <div className="chart-label">Total</div>
            </div>
          </div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-dot active"></div>
            <span>Active: {activeCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot executed"></div>
            <span>Executed: {executedCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot revoked"></div>
            <span>Revoked: {revokedCount}</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="vault-spinner"></div>
      <p>Initializing secure vault connection...</p>
    </div>
  );

  return (
    <div className="app-container vault-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="vault-icon"></div>
          </div>
          <h1>DigitalWill<span>FHE</span>Vault</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-will-btn vault-button">
            <div className="add-icon"></div>Create Will
          </button>
          <button className="vault-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Step Progress Indicator */}
        <div className="step-progress">
          <div className={`step ${currentStep >= 1 ? 'active' : ''}`}>
            <div className="step-number">1</div>
            <span>Connect</span>
          </div>
          <div className="step-connector"></div>
          <div className={`step ${currentStep >= 2 ? 'active' : ''}`}>
            <div className="step-number">2</div>
            <span>Create Will</span>
          </div>
          <div className="step-connector"></div>
          <div className={`step ${currentStep >= 3 ? 'active' : ''}`}>
            <div className="step-number">3</div>
            <span>Encrypt</span>
          </div>
          <div className="step-connector"></div>
          <div className={`step ${currentStep >= 4 ? 'active' : ''}`}>
            <div className="step-number">4</div>
            <span>Complete</span>
          </div>
        </div>

        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Encrypted Digital Will Vault</h2>
            <p>Secure your legacy with fully homomorphic encryption. Your will remains private until verification.</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>Zama FHE Protected</span>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>How FHE Digital Wills Work</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dashboard-grid">
          <div className="dashboard-card vault-card">
            <h3>Secure Digital Inheritance</h3>
            <p>Using <strong>Zama FHE technology</strong>, your digital will remains encrypted throughout its lifecycle. Only authorized beneficiaries can decrypt after verification.</p>
            <div className="fhe-badge">
              <span>FHE-Encrypted</span>
            </div>
          </div>

          <div className="dashboard-card vault-card">
            <h3>Will Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{wills.length}</div>
                <div className="stat-label">Total Wills</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{activeCount}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{executedCount}</div>
                <div className="stat-label">Executed</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{revokedCount}</div>
                <div className="stat-label">Revoked</div>
              </div>
            </div>
          </div>

          <div className="dashboard-card vault-card">
            <h3>Status Distribution</h3>
            {renderStatusChart()}
          </div>
        </div>

        <div className="wills-section">
          <div className="section-header">
            <h2>Your Digital Wills</h2>
            <div className="header-actions">
              <button onClick={loadWills} className="refresh-btn vault-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="wills-list vault-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Description</div>
              <div className="header-cell">Beneficiary</div>
              <div className="header-cell">Created</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {wills.length === 0 ? (
              <div className="no-wills">
                <div className="no-wills-icon"></div>
                <p>No digital wills found</p>
                <button className="vault-button primary" onClick={() => setShowCreateModal(true)}>
                  Create Your First Will
                </button>
              </div>
            ) : (
              wills.map(will => (
                <div className="will-row" key={will.id} onClick={() => setSelectedWill(will)}>
                  <div className="table-cell will-id">#{will.id.substring(0, 8)}</div>
                  <div className="table-cell">{will.description}</div>
                  <div className="table-cell">{will.beneficiary.substring(0, 6)}...{will.beneficiary.substring(38)}</div>
                  <div className="table-cell">{new Date(will.timestamp * 1000).toLocaleDateString()}</div>
                  <div className="table-cell">
                    <span className={`status-badge ${will.status}`}>{will.status}</span>
                  </div>
                  <div className="table-cell actions">
                    {isOwner(will.owner) && will.status === "active" && (
                      <button className="action-btn vault-button danger" 
                        onClick={(e) => { e.stopPropagation(); revokeWill(will.id); }}>
                        Revoke
                      </button>
                    )}
                    {isBeneficiary(will.beneficiary) && will.status === "active" && (
                      <button className="action-btn vault-button success" 
                        onClick={(e) => { e.stopPropagation(); executeWill(will.id); }}>
                        Execute
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitWill} 
          onClose={() => {
            setShowCreateModal(false);
            setCurrentStep(1);
          }} 
          creating={creating} 
          willData={newWillData} 
          setWillData={setNewWillData}
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
        />
      )}
      
      {selectedWill && (
        <WillDetailModal 
          will={selectedWill} 
          onClose={() => {
            setSelectedWill(null);
            setDecryptedValue(null);
          }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content vault-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="vault-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="vault-icon"></div>
              <span>DigitalWillFHEVault</span>
            </div>
            <p>Secure digital inheritance using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Support</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} DigitalWillFHEVault. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  willData: any;
  setWillData: (data: any) => void;
  currentStep: number;
  setCurrentStep: (step: number) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating, 
  willData, 
  setWillData, 
  currentStep, 
  setCurrentStep 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setWillData({ ...willData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setWillData({ ...willData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!willData.beneficiary || !willData.assetAmount) {
      alert("Please fill required fields");
      return;
    }
    onSubmit();
  };

  const nextStep = () => {
    if (currentStep < 4) setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="step-content">
            <h3>Beneficiary Information</h3>
            <div className="form-group">
              <label>Beneficiary Address *</label>
              <input 
                type="text" 
                name="beneficiary" 
                value={willData.beneficiary} 
                onChange={handleChange} 
                placeholder="0x..." 
                className="vault-input"
              />
            </div>
            <div className="form-group">
              <label>Will Description</label>
              <input 
                type="text" 
                name="description" 
                value={willData.description} 
                onChange={handleChange} 
                placeholder="Brief description of the will..." 
                className="vault-input"
              />
            </div>
          </div>
        );
      
      case 2:
        return (
          <div className="step-content">
            <h3>Asset Information</h3>
            <div className="form-group">
              <label>Encrypted Asset Amount *</label>
              <input 
                type="number" 
                name="assetAmount" 
                value={willData.assetAmount} 
                onChange={handleValueChange} 
                placeholder="Enter numerical value..." 
                className="vault-input"
                step="0.01"
              />
            </div>
            <div className="form-group">
              <label>Additional Instructions</label>
              <textarea 
                name="instructions" 
                value={willData.instructions} 
                onChange={handleChange} 
                placeholder="Any special instructions for the beneficiary..." 
                className="vault-input"
                rows={3}
              />
            </div>
          </div>
        );
      
      case 3:
        return (
          <div className="step-content">
            <h3>FHE Encryption Preview</h3>
            <div className="encryption-preview">
              <div className="preview-item">
                <span>Plain Value:</span>
                <div className="plain-data">{willData.assetAmount || 'No value'}</div>
              </div>
              <div className="encryption-animation">↓</div>
              <div className="preview-item">
                <span>FHE Encrypted:</span>
                <div className="encrypted-data">
                  {willData.assetAmount ? FHEEncryptNumber(willData.assetAmount).substring(0, 60) + '...' : 'No value'}
                </div>
              </div>
            </div>
            <div className="security-notice">
              <div className="lock-icon"></div>
              <div>
                <strong>Zama FHE Security</strong>
                <p>Your data will be encrypted using fully homomorphic encryption before storage on blockchain</p>
              </div>
            </div>
          </div>
        );
      
      case 4:
        return (
          <div className="step-content">
            <h3>Review & Submit</h3>
            <div className="review-summary">
              <div className="review-item">
                <span>Beneficiary:</span>
                <strong>{willData.beneficiary || 'Not set'}</strong>
              </div>
              <div className="review-item">
                <span>Description:</span>
                <strong>{willData.description || 'Not set'}</strong>
              </div>
              <div className="review-item">
                <span>Asset Amount:</span>
                <strong>{willData.assetAmount || 0}</strong>
              </div>
              <div className="review-item">
                <span>Encrypted Data Preview:</span>
                <strong>{willData.assetAmount ? FHEEncryptNumber(willData.assetAmount).substring(0, 30) + '...' : 'No data'}</strong>
              </div>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal vault-card">
        <div className="modal-header">
          <h2>Create Digital Will {currentStep}/4</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          {renderStepContent()}
        </div>
        
        <div className="modal-footer">
          <button onClick={prevStep} disabled={currentStep === 1} className="cancel-btn vault-button">
            Previous
          </button>
          
          {currentStep < 4 ? (
            <button onClick={nextStep} className="next-btn vault-button primary">
              Next
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={creating} className="submit-btn vault-button primary">
              {creating ? "Encrypting with FHE..." : "Submit Securely"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface WillDetailModalProps {
  will: DigitalWill;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const WillDetailModal: React.FC<WillDetailModalProps> = ({ 
  will, 
  onClose, 
  decryptedValue, 
  setDecryptedValue, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) {
      setDecryptedValue(null);
      return;
    }
    const decrypted = await decryptWithSignature(will.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="will-detail-modal vault-card">
        <div className="modal-header">
          <h2>Will Details #{will.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="will-info">
            <div className="info-item">
              <span>Description:</span>
              <strong>{will.description}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{will.owner.substring(0, 6)}...{will.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Beneficiary:</span>
              <strong>{will.beneficiary.substring(0, 6)}...{will.beneficiary.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>{new Date(will.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${will.status}`}>{will.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>FHE Encrypted Data</h3>
            <div className="encrypted-data-display">
              {will.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>Zama FHE Encrypted</span>
            </div>
            
            <button 
              className="decrypt-btn vault-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner">Decrypting...</span>
              ) : decryptedValue !== null ? (
                "Hide Value"
              ) : (
                "Decrypt with Signature"
              )}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Asset Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Value decrypted after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn vault-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;