// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Testnet provenance commitments for synthetic demo issuance. Does not create tradeable carbon tokens.
contract DemoProofRegistry {
    uint256 public constant VERSION = 1;
    address public immutable writer;
    struct Proof { bytes32 commitment; uint64 anchorSeq; bytes32 anchorHash; uint64 blockNumber; }
    mapping(bytes32 => Proof) public proofs;
    mapping(uint64 => bytes32) public anchors;
    event ProofRecorded(bytes32 indexed effectId, bytes32 commitment, uint64 anchorSeq, bytes32 anchorHash);
    error Unauthorized();
    error Conflict();
    error InvalidProof();
    constructor(address writer_) { if (writer_ == address(0)) revert InvalidProof(); writer = writer_; }
    function recordProof(bytes32 effectId, bytes32 commitment, uint64 anchorSeq, bytes32 anchorHash) external {
        if (msg.sender != writer) revert Unauthorized();
        if (effectId == bytes32(0) || commitment == bytes32(0) || anchorSeq == 0 || anchorHash == bytes32(0)) revert InvalidProof();
        Proof memory old = proofs[effectId];
        if (old.blockNumber != 0) {
            if (old.commitment != commitment || old.anchorSeq != anchorSeq || old.anchorHash != anchorHash) revert Conflict();
            return;
        }
        if (anchors[anchorSeq] != bytes32(0) && anchors[anchorSeq] != anchorHash) revert Conflict();
        anchors[anchorSeq] = anchorHash;
        proofs[effectId] = Proof(commitment, anchorSeq, anchorHash, uint64(block.number));
        emit ProofRecorded(effectId, commitment, anchorSeq, anchorHash);
    }
}
